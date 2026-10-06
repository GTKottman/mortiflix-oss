/*
 * Nova FX — simulation core.
 *
 * Particles  : structure-of-arrays, OpenMP, deterministic hash RNG (results do not depend on
 *              thread count), event graph per particle type (death bursts, trails, splitting,
 *              collision spawns), curl-noise turbulence, force objects, analytic colliders,
 *              two-way coupling with the fluid grid, physically based incandescence
 *              (Planck spectrum integrated against CIE 1931 colour matching functions).
 * Fluid      : incompressible Navier–Stokes on a staggered MAC grid.
 *              - MacCormack advection with Selle et al. 2008 min/max clamping
 *              - advection–reflection (Zehnder, Narain, Thomaszewski 2018) to keep the
 *                swirl energy that plain semi-Lagrangian steps lose
 *              - vorticity confinement (Fedkiw, Stam, Jensen 2001)
 *              - combustion: fuel + ignition temperature + heat release + smoke yield +
 *                volume expansion fed into the pressure solve (explosions push outward)
 *              - Newton + radiative (T^4, Stefan–Boltzmann) cooling
 *              - pressure: conjugate gradient preconditioned by a geometric multigrid V-cycle
 *                (MGPCG, McAdams, Sifakis, Teran 2010)
 *
 * Everything is exposed through a flat C API used from Python with ctypes.
 * Parameter tables are X-macros so the Python side reads names/defaults from this file.
 */

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#if defined(__x86_64__) || defined(__i386__)
#include <xmmintrin.h>
#define HAVE_SSE 1
#endif
#ifdef _OPENMP
#include <omp.h>
#else
static int omp_get_max_threads(void) { return 1; }
static int omp_get_thread_num(void) { return 0; }
static void omp_set_num_threads(int n) { (void)n; }
#endif

#define API __attribute__((visibility("default")))
#define MAXK 32
#define MAXCOL 64
#define MAXFRC 64
#define MAXGEN 15

/* ===================================================================== parameter tables */

#include "nova_params.h"

/* GPU backend (gpu_vk.c). Weak: the core links and runs without it. */
typedef struct GpuFluid GpuFluid;
#define WEAK __attribute__((weak))
WEAK GpuFluid *gpuf_new(int nx, int ny, int nz, float dx, const float *o, int nlev, const int *ldims);
WEAK void gpuf_free(GpuFluid *g);
WEAK void gpuf_reset(GpuFluid *g);
WEAK void gpuf_set_stencils(GpuFluid *g, const uint8_t *solid, uint8_t *const *diag, uint8_t *const *nb,
                            const uint8_t *perm);
WEAK void gpuf_substep(GpuFluid *g, const float *fp, float dt, double time);
WEAK float gpuf_max_speed(GpuFluid *g);
WEAK void gpuf_splat(GpuFluid *g, int n, const float *pos, float radius, float dens, float heat, float fuel,
                     const float *vel, float vel_amt, int mode);
WEAK void gpuf_deposit(GpuFluid *g, int n, const float *pos, const float *amt);
WEAK void gpuf_download(GpuFluid *g, int which, float *dst);
WEAK void gpuf_download_velocity(GpuFluid *g, float *u, float *v, float *w);
WEAK int gpuf_active_bbox(GpuFluid *g, int *b);
WEAK void gpuf_stats(GpuFluid *g, int *iters, float *res, double *ms);

#define E_K(n, d) KP_##n,
#define E_S(n, d) SP_##n,
enum { KIND_PARAMS(E_K) KP_COUNT };
enum { SYS_PARAMS(E_S) SP_COUNT };
#define NAME(n, d) #n ","
#define DEF(n, d) (float)(d),
static const char kind_names[] = KIND_PARAMS(NAME);
static const float kind_defs[] = {KIND_PARAMS(DEF)};
static const char sys_names[] = SYS_PARAMS(NAME);
static const float sys_defs[] = {SYS_PARAMS(DEF)};
static const char fluid_names[] = FLUID_PARAMS(NAME);
static const float fluid_defs[] = {FLUID_PARAMS(DEF)};

API const char *nv_kind_param_names(void) { return kind_names; }
API const char *nv_sys_param_names(void) { return sys_names; }
API const char *nv_fluid_param_names(void) { return fluid_names; }
API int nv_kind_param_count(void) { return KP_COUNT; }
API int nv_sys_param_count(void) { return SP_COUNT; }
API int nv_fluid_param_count(void) { return FP_COUNT; }
API void nv_kind_param_defaults(float *o) { memcpy(o, kind_defs, sizeof kind_defs); }
API void nv_sys_param_defaults(float *o) { memcpy(o, sys_defs, sizeof sys_defs); }
API void nv_fluid_param_defaults(float *o) { memcpy(o, fluid_defs, sizeof fluid_defs); }
API int nv_version(void) { return 100; }
API int nv_num_threads(void) { return omp_get_max_threads(); }
API void nv_set_threads(int n) {
  if (n > 0) omp_set_num_threads(n);
}

/* -ffast-math only flushes denormals in executables; a shared library has to do it itself,
 * in every worker thread, or decaying fields crawl through microcode-assisted denormal math. */
static void ftz(void) {
#ifdef HAVE_SSE
#pragma omp parallel
  _mm_setcsr(_mm_getcsr() | 0x8040);
#endif
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec * 1e-6;
}

/* ===================================================================== small math */

static inline float clampf(float x, float a, float b) { return x < a ? a : (x > b ? b : x); }
static inline float lerpf(float a, float b, float t) { return a + (b - a) * t; }
static inline float smooth01(float x) {
  x = clampf(x, 0.f, 1.f);
  return x * x * (3.f - 2.f * x);
}

static inline uint32_t pcg(uint32_t v) {
  uint32_t s = v * 747796405u + 2891336453u;
  uint32_t w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
static inline uint32_t h3(uint32_t a, uint32_t b, uint32_t c) { return pcg(a ^ pcg(b ^ pcg(c))); }
static inline float u01(uint32_t h) { return (float)(h >> 8) * (1.0f / 16777216.0f); }

static inline void rand_dir(uint32_t h, float *d) {
  float z = 2.f * u01(h) - 1.f;
  float a = 6.2831853f * u01(pcg(h + 0x9E3779B9u));
  float r = sqrtf(fmaxf(0.f, 1.f - z * z));
  d[0] = r * cosf(a);
  d[1] = r * sinf(a);
  d[2] = z;
}

/* orthonormal basis around n (unit) */
static inline void basis(const float *n, float *t, float *b) {
  float s = n[2] >= 0.f ? 1.f : -1.f;
  float a = -1.f / (s + n[2]);
  float bb = n[0] * n[1] * a;
  t[0] = 1.f + s * n[0] * n[0] * a;
  t[1] = s * bb;
  t[2] = -s * n[0];
  b[0] = bb;
  b[1] = s + n[1] * n[1] * a;
  b[2] = -n[1];
}

/* ============================================================== gradient noise + curl */

static const float GRAD[16][3] = {{1, 1, 0},  {-1, 1, 0}, {1, -1, 0}, {-1, -1, 0}, {1, 0, 1},  {-1, 0, 1},
                                  {1, 0, -1}, {-1, 0, -1}, {0, 1, 1}, {0, -1, 1},  {0, 1, -1}, {0, -1, -1},
                                  {1, 1, 0},  {-1, 1, 0}, {0, -1, 1}, {0, -1, -1}};

static uint8_t PERM[512];
static int perm_ready = 0;
static void perm_init(void) {
  if (perm_ready) return;
  uint8_t p[256];
  for (int i = 0; i < 256; i++) p[i] = (uint8_t)i;
  for (int i = 255; i > 0; i--) {
    int j = (int)(pcg(0xC0FFEEu + (uint32_t)i) % (uint32_t)(i + 1));
    uint8_t t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (int i = 0; i < 512; i++) PERM[i] = p[i & 255];
  perm_ready = 1;
}
static inline const float *ghash(int x, int y, int z, uint32_t seed) {
  return GRAD[PERM[PERM[PERM[(x + (int)(seed * 37u)) & 255] + (y & 255)] + (z & 255)] & 15];
}

/* 3D gradient noise with analytic derivatives (quintic), after I. Quilez. out = {v, dx, dy, dz} */
static void noised(float x, float y, float z, uint32_t seed, float *out) {
  float fx0 = floorf(x), fy0 = floorf(y), fz0 = floorf(z);
  int ix = (int)fx0, iy = (int)fy0, iz = (int)fz0;
  float fx = x - fx0, fy = y - fy0, fz = z - fz0;
  float ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10),
        uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  float dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1),
        duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const float *ga = ghash(ix, iy, iz, seed), *gb = ghash(ix + 1, iy, iz, seed), *gc = ghash(ix, iy + 1, iz, seed),
              *gd = ghash(ix + 1, iy + 1, iz, seed), *ge = ghash(ix, iy, iz + 1, seed),
              *gf = ghash(ix + 1, iy, iz + 1, seed), *gg = ghash(ix, iy + 1, iz + 1, seed),
              *gh = ghash(ix + 1, iy + 1, iz + 1, seed);
  float va = ga[0] * fx + ga[1] * fy + ga[2] * fz;
  float vb = gb[0] * (fx - 1) + gb[1] * fy + gb[2] * fz;
  float vc = gc[0] * fx + gc[1] * (fy - 1) + gc[2] * fz;
  float vd = gd[0] * (fx - 1) + gd[1] * (fy - 1) + gd[2] * fz;
  float ve = ge[0] * fx + ge[1] * fy + ge[2] * (fz - 1);
  float vf = gf[0] * (fx - 1) + gf[1] * fy + gf[2] * (fz - 1);
  float vg = gg[0] * fx + gg[1] * (fy - 1) + gg[2] * (fz - 1);
  float vh = gh[0] * (fx - 1) + gh[1] * (fy - 1) + gh[2] * (fz - 1);
  float k0 = va, k1 = vb - va, k2 = vc - va, k3 = ve - va, k4 = va - vb - vc + vd, k5 = va - vc - ve + vg,
        k6 = va - vb - ve + vf, k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  out[0] = k0 + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
  for (int c = 0; c < 3; c++) {
    float g0 = ga[c], g1 = gb[c] - ga[c], g2 = gc[c] - ga[c], g3 = ge[c] - ga[c],
          g4 = ga[c] - gb[c] - gc[c] + gd[c], g5 = ga[c] - gc[c] - ge[c] + gg[c], g6 = ga[c] - gb[c] - ge[c] + gf[c],
          g7 = -ga[c] + gb[c] + gc[c] - gd[c] + ge[c] - gf[c] - gg[c] + gh[c];
    out[1 + c] = g0 + g1 * ux + g2 * uy + g3 * uz + g4 * ux * uy + g5 * uy * uz + g6 * uz * ux + g7 * ux * uy * uz;
  }
  out[1] += dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
  out[2] += duy * (k2 + k4 * ux + k5 * uz + k7 * ux * uz);
  out[3] += duz * (k3 + k5 * uy + k6 * ux + k7 * ux * uy);
}

/* Divergence-free curl noise (Bridson, Hourihan, Nordenstam 2007), fBm, time-evolving. */
static void curl_noise(float x, float y, float z, float t, int oct, uint32_t seed, float *c) {
  float a[4], b[4], d[4];
  float amp = 1.f, fr = 1.f;
  c[0] = c[1] = c[2] = 0.f;
  for (int o = 0; o < oct; o++) {
    float sx = x * fr + t * 0.31f * (o + 1), sy = y * fr - t * 0.23f, sz = z * fr + t * 0.17f * (o + 2);
    uint32_t s = seed + 1013u * o;
    noised(sx, sy, sz, s, a);
    noised(sx + 31.4f, sy - 17.1f, sz + 9.2f, s + 1, b);
    noised(sx - 11.7f, sy + 41.3f, sz - 27.9f, s + 2, d);
    /* psi = (a, b, d); curl = (dd/dy - db/dz, da/dz - dd/dx, db/dx - da/dy) */
    c[0] += amp * (d[2] - b[3]);
    c[1] += amp * (a[3] - d[1]);
    c[2] += amp * (b[1] - a[2]);
    amp *= 0.5f;
    fr *= 2.f;
  }
}

/* ================================================== blackbody colour (Planck x CIE 1931) */

#define BB_N 256
#define BB_TMIN 400.f
#define BB_TMAX 12000.f
static float bb_tab[BB_N][3];
static int bb_ready = 0;

static double cie_g(double l, double mu, double s1, double s2) {
  double s = l < mu ? s1 : s2, t = (l - mu) / s;
  return exp(-0.5 * t * t);
}
/* Wyman, Sloan, Shirley 2013 multi-lobe fit of the CIE 1931 2° observer */
static void cie_xyz(double l, double *X, double *Y, double *Z) {
  *X = 1.056 * cie_g(l, 599.8, 37.9, 31.0) + 0.362 * cie_g(l, 442.0, 16.0, 26.7) -
       0.065 * cie_g(l, 501.1, 20.4, 26.2);
  *Y = 0.821 * cie_g(l, 568.8, 46.9, 40.5) + 0.286 * cie_g(l, 530.9, 16.3, 31.1);
  *Z = 1.217 * cie_g(l, 437.0, 11.8, 36.0) + 0.681 * cie_g(l, 459.0, 26.0, 13.8);
}
static void bb_init(void) {
  perm_init();
  if (bb_ready) return;
  for (int i = 0; i < BB_N; i++) {
    double T = BB_TMIN + (BB_TMAX - BB_TMIN) * i / (BB_N - 1);
    double X = 0, Y = 0, Z = 0;
    for (double l = 380; l <= 780; l += 2) {
      double lm = l * 1e-9;
      double B = 1.0 / (pow(lm, 5) * (exp(0.014387769 / (lm * T)) - 1.0));
      double x, y, z;
      cie_xyz(l, &x, &y, &z);
      X += B * x;
      Y += B * y;
      Z += B * z;
    }
    double r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    double g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    double b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = r < 0 ? 0 : r;
    g = g < 0 ? 0 : g;
    b = b < 0 ? 0 : b;
    double m = fmax(r, fmax(g, b));
    bb_tab[i][0] = (float)(r / m);
    bb_tab[i][1] = (float)(g / m);
    bb_tab[i][2] = (float)(b / m);
  }
  bb_ready = 1;
}
static inline void bb_color(float T, float *c) {
  float f = (T - BB_TMIN) / (BB_TMAX - BB_TMIN) * (BB_N - 1);
  f = clampf(f, 0.f, BB_N - 1.001f);
  int i = (int)f;
  float t = f - i;
  for (int k = 0; k < 3; k++) c[k] = lerpf(bb_tab[i][k], bb_tab[i + 1][k], t);
}
API void nv_blackbody(float T, float *rgb) {
  bb_init();
  bb_color(T, rgb);
}

/* ======================================================================== fluid grid */

typedef struct {
  int nx, ny, nz;
  uint8_t *diag, *nb; /* active neighbour count, fluid neighbour bits */
  uint8_t *type;      /* 0 fluid, 1 solid (Neumann), 2 air (Dirichlet) */
  float *x, *b, *r;
  int own_xb; /* level 0 borrows x/b from the CG vectors */
  /* 8^3 blocks: the solver only visits blocks that hold fluid cells */
  int nbx, nby, nbz, nbk;
  uint8_t *bact, *bmark;
  int *blist, nbl, *mlist, nml, *slist, nsl;
} Lev;

typedef struct {
  int nx, ny, nz;
  float o[3], dx; /* local-space origin of sample (0,0,0) and spacing */
  float *d;       /* signed distance, negative inside */
} Sdf;

#define MAXSDF 32

typedef struct {
  int type; /* 0 plane, 1 sphere, 2 box, 3 mesh (signed distance field; ext[0] = sdf slot) */
  float m[12], mi[12]; /* world->local, local->world (3x4 row major) */
  float ext[3];        /* sphere: radius in [0]; box: half extents */
  float vel[3];
  float smin;          /* smallest local->world scale: turns local distances into safe world bounds */
  float pinv;          /* plane: 1 / |grad of local z| (exact world distance) */
} Collider;

typedef struct {
  int type; /* 0 attract, 1 vortex, 2 wind, 3 turbulence, 4 drag */
  float pos[3], axis[3];
  float strength, radius, freq, falloff;
} Force;

typedef struct NvFluid {
  int nx, ny, nz;
  size_t nc, nu, nv, nw;
  float dx, o[3];
  float fp[FP_COUNT];
  float *u, *v, *w, *u0, *v0, *w0, *u1, *v1, *w1;
  float *d, *T, *fuel, *flame, *expn, *phi;
  uint8_t *solid;
  float *tmp[10];
  float *cg_r, *cg_z, *cg_p, *cg_q, *cg_b;
  Lev lev[16];
  int nlev;
  int last_iters;
  float last_res, maxvel;
  double time, ms;
  double tm_adv, tm_frc, tm_prj, tm_cmb;
  int solid_dirty;
  /* sparse tiles */
  int ntx, nty, ntz, nt;
  uint8_t *t_cont, *t_adv, *t_prs, *t_prev, *ctype;
  uint8_t *t_dirty; /* tiles written by sources since the last scan */
  uint8_t *t_force; /* tiles whose solid cells changed (re-type them) */
  int *tl_adv, *tl_prs, n_adv, n_prs, *tl_chg, n_chg, *cand;
  int vox_pending, vox_box[6]; /* cells to re-voxelize against the colliders */
  GpuFluid *gpu;               /* non-NULL: the solver runs on the GPU, CPU arrays are download targets */
  int hier_ver, gpu_hier_ver;
} NvFluid;

#define TS 8
#define CI(f, i, j, k) ((size_t)(i) + (size_t)(f)->nx * ((size_t)(j) + (size_t)(f)->ny * (size_t)(k)))
#define UI(f, i, j, k) ((size_t)(i) + (size_t)((f)->nx + 1) * ((size_t)(j) + (size_t)(f)->ny * (size_t)(k)))
#define VI(f, i, j, k) ((size_t)(i) + (size_t)(f)->nx * ((size_t)(j) + (size_t)((f)->ny + 1) * (size_t)(k)))
#define WI(f, i, j, k) ((size_t)(i) + (size_t)(f)->nx * ((size_t)(j) + (size_t)(f)->ny * (size_t)(k)))

/* calloc, not malloc+memset: big blocks come from the OS as zero pages that only become real memory
 * when touched, and the sparse solver never touches empty regions. */
static float *falloc(size_t n) { return (float *)calloc(n ? n : 1, sizeof(float)); }
static uint8_t *balloc(size_t n) { return (uint8_t *)calloc(n ? n : 1, 1); }

static void lev_alloc(Lev *L, int nx, int ny, int nz, int own) {
  size_t n = (size_t)nx * ny * nz;
  L->nx = nx;
  L->ny = ny;
  L->nz = nz;
  L->diag = balloc(n);
  L->nb = balloc(n);
  L->r = falloc(n);
  L->own_xb = own;
  if (own) {
    L->x = falloc(n);
    L->b = falloc(n);
    L->type = balloc(n);
  }
  L->nbx = (nx + 7) / 8; L->nby = (ny + 7) / 8; L->nbz = (nz + 7) / 8;
  L->nbk = L->nbx * L->nby * L->nbz;
  L->bact = balloc(L->nbk);
  L->bmark = balloc(L->nbk);
  L->blist = (int *)malloc(sizeof(int) * L->nbk);
  L->mlist = (int *)malloc(sizeof(int) * L->nbk);
  L->slist = (int *)malloc(sizeof(int) * L->nbk);
}

API NvFluid *nv_fluid_new(int nx, int ny, int nz, float dx, float ox, float oy, float oz) {
  bb_init();
  NvFluid *f = (NvFluid *)calloc(1, sizeof(NvFluid));
  f->nx = nx;
  f->ny = ny;
  f->nz = nz;
  f->dx = dx;
  f->o[0] = ox;
  f->o[1] = oy;
  f->o[2] = oz;
  memcpy(f->fp, fluid_defs, sizeof fluid_defs);
  f->nc = (size_t)nx * ny * nz;
  f->nu = (size_t)(nx + 1) * ny * nz;
  f->nv = (size_t)nx * (ny + 1) * nz;
  f->nw = (size_t)nx * ny * (nz + 1);
  size_t big = (size_t)(nx + 1) * (ny + 1) * (nz + 1);
  f->u = falloc(f->nu); f->v = falloc(f->nv); f->w = falloc(f->nw);
  f->u0 = falloc(f->nu); f->v0 = falloc(f->nv); f->w0 = falloc(f->nw);
  f->u1 = falloc(f->nu); f->v1 = falloc(f->nv); f->w1 = falloc(f->nw);
  f->d = falloc(f->nc); f->T = falloc(f->nc); f->fuel = falloc(f->nc); f->flame = falloc(f->nc);
  f->expn = falloc(f->nc); f->phi = falloc(f->nc);
  f->solid = balloc(f->nc);
  for (int i = 0; i < 10; i++) f->tmp[i] = falloc(big);
  f->cg_r = falloc(f->nc); f->cg_z = falloc(f->nc); f->cg_p = falloc(f->nc); f->cg_q = falloc(f->nc);
  f->cg_b = falloc(f->nc);
  /* multigrid hierarchy */
  int lx = nx, ly = ny, lz = nz, L = 0;
  lev_alloc(&f->lev[0], lx, ly, lz, 0);
  f->lev[0].x = f->cg_z;
  f->lev[0].b = f->cg_r;
  while (L < 15 && (lx > 4 || ly > 4 || lz > 4)) {
    lx = (lx + 1) / 2; ly = (ly + 1) / 2; lz = (lz + 1) / 2;
    L++;
    lev_alloc(&f->lev[L], lx, ly, lz, 1);
    if (lx <= 4 && ly <= 4 && lz <= 4) break;
  }
  f->nlev = L + 1;
  f->solid_dirty = 1;
  f->ntx = (nx + TS - 1) / TS; f->nty = (ny + TS - 1) / TS; f->ntz = (nz + TS - 1) / TS;
  f->nt = f->ntx * f->nty * f->ntz;
  f->t_cont = balloc(f->nt); f->t_adv = balloc(f->nt); f->t_prs = balloc(f->nt); f->t_prev = balloc(f->nt);
  f->tl_adv = (int *)malloc(sizeof(int) * f->nt); f->tl_prs = (int *)malloc(sizeof(int) * f->nt);
  f->tl_chg = (int *)malloc(sizeof(int) * f->nt); f->cand = (int *)malloc(sizeof(int) * f->nt);
  f->t_dirty = balloc(f->nt); f->t_force = balloc(f->nt);
  f->ctype = balloc(f->nc);
  f->lev[0].type = f->ctype;
  return f;
}

API void nv_fluid_free(NvFluid *f) {
  if (!f) return;
  if (f->gpu && gpuf_free) gpuf_free(f->gpu);
  float *arrs[] = {f->u, f->v, f->w, f->u0, f->v0, f->w0, f->u1, f->v1, f->w1, f->d, f->T, f->fuel,
                   f->flame, f->expn, f->phi, f->cg_r, f->cg_z, f->cg_p, f->cg_q, f->cg_b};
  for (size_t i = 0; i < sizeof arrs / sizeof *arrs; i++) free(arrs[i]);
  for (int i = 0; i < 10; i++) free(f->tmp[i]);
  free(f->solid);
  free(f->t_cont); free(f->t_adv); free(f->t_prs); free(f->t_prev); free(f->tl_adv); free(f->tl_prs);
  free(f->ctype);
  free(f->tl_chg); free(f->cand); free(f->t_dirty); free(f->t_force);
  for (int l = 0; l < f->nlev; l++) {
    Lev *L = &f->lev[l];
    free(L->diag); free(L->nb); free(L->r);
    if (L->own_xb) { free(L->x); free(L->b); free(L->type); }
    free(L->bact); free(L->bmark); free(L->blist); free(L->mlist); free(L->slist);
  }
  free(f);
}

API void nv_fluid_set_params(NvFluid *f, const float *p) { memcpy(f->fp, p, sizeof f->fp); }

static void refresh(float **a, size_t n) {
  free(*a);
  *a = falloc(n); /* fresh zero pages: O(1) work, and memory goes back to the OS */
}

API void nv_fluid_reset(NvFluid *f) {
  refresh(&f->u, f->nu); refresh(&f->v, f->nv); refresh(&f->w, f->nw);
  refresh(&f->u0, f->nu); refresh(&f->v0, f->nv); refresh(&f->w0, f->nw);
  refresh(&f->u1, f->nu); refresh(&f->v1, f->nv); refresh(&f->w1, f->nw);
  refresh(&f->d, f->nc); refresh(&f->T, f->nc); refresh(&f->fuel, f->nc); refresh(&f->flame, f->nc);
  refresh(&f->expn, f->nc); refresh(&f->phi, f->nc);
  memset(f->t_cont, 0, f->nt); memset(f->t_adv, 0, f->nt); memset(f->t_prs, 0, f->nt);
  memset(f->t_prev, 0, f->nt); memset(f->t_dirty, 0, f->nt); memset(f->t_force, 0, f->nt);
  f->n_adv = f->n_prs = 0;
  for (int l = 0; l < f->nlev; l++) {
    memset(f->lev[l].bact, 0, f->lev[l].nbk);
    f->lev[l].nbl = 0;
  }
  f->solid_dirty = 1;
  f->time = 0;
  if (f->gpu) gpuf_reset(f->gpu);
}

/* Move the solver to the GPU (on = 1) or back (0). Returns 1 if the GPU is in use. Fields restart
 * empty on the GPU, so switch at the start of a simulation. */
API int nv_fluid_set_gpu(NvFluid *f, int on) {
  if (!on || !gpuf_new) {
    if (f->gpu) gpuf_free(f->gpu);
    f->gpu = NULL;
    return 0;
  }
  if (f->gpu) return 1;
  int dims[3 * 16];
  for (int l = 0; l < f->nlev; l++) {
    dims[3 * l] = f->lev[l].nx; dims[3 * l + 1] = f->lev[l].ny; dims[3 * l + 2] = f->lev[l].nz;
  }
  f->gpu = gpuf_new(f->nx, f->ny, f->nz, f->dx, f->o, f->nlev, dims);
  f->gpu_hier_ver = -1;
  f->solid_dirty = 1;
  return f->gpu ? 1 : 0;
}

WEAK void nv_gpu_phases(void *fluid_gpu, double *out);
/* GPU time per solver phase since the last call (ms): adv scalars, combust, adv velocity, forces, project, other */
API int nv_fluid_gpu_phases(NvFluid *f, double *out) {
  if (!f->gpu || !nv_gpu_phases) return 0;
  nv_gpu_phases(f->gpu, out);
  return 1;
}

/* GPU mode: copy the scalar fields (and velocities if asked) into the CPU arrays read by Python */
API void nv_fluid_sync(NvFluid *f, int with_velocity) {
  if (!f->gpu) return;
  gpuf_download(f->gpu, 0, f->d);
  gpuf_download(f->gpu, 1, f->T);
  gpuf_download(f->gpu, 2, f->fuel);
  gpuf_download(f->gpu, 3, f->flame);
  if (with_velocity) {
    gpuf_download(f->gpu, 4, f->u);
    gpuf_download(f->gpu, 5, f->v);
    gpuf_download(f->gpu, 6, f->w);
  }
}

API float *nv_fluid_ptr(NvFluid *f, int which) {
  switch (which) {
    case 0: return f->d;
    case 1: return f->T;
    case 2: return f->fuel;
    case 3: return f->flame;
    case 4: return f->u;
    case 5: return f->v;
    case 6: return f->w;
    default: return NULL;
  }
}
API uint8_t *nv_fluid_solid_ptr(NvFluid *f) { return f->solid; }

/* cell-centred velocity, layout [k][j][i][3] */
API void nv_fluid_cell_velocity(NvFluid *f, float *out) {
#pragma omp parallel for schedule(static)
  for (int k = 0; k < f->nz; k++)
    for (int j = 0; j < f->ny; j++)
      for (int i = 0; i < f->nx; i++) {
        size_t c = CI(f, i, j, k);
        out[c * 3 + 0] = 0.5f * (f->u[UI(f, i, j, k)] + f->u[UI(f, i + 1, j, k)]);
        out[c * 3 + 1] = 0.5f * (f->v[VI(f, i, j, k)] + f->v[VI(f, i, j + 1, k)]);
        out[c * 3 + 2] = 0.5f * (f->w[WI(f, i, j, k)] + f->w[WI(f, i, j, k + 1)]);
      }
}

/* ---------------------------------------------------------------- trilinear sampling */

/* sample array a (dims sx,sy,sz) at index-space coordinate (x,y,z). zero=1: 0 outside, else clamp. */
static inline float samp(const float *a, int sx, int sy, int sz, float x, float y, float z, int zero) {
  if (zero) {
    if (x < -1.f || y < -1.f || z < -1.f || x > sx || y > sy || z > sz) return 0.f;
  }
  x = clampf(x, zero ? -1.f : 0.f, zero ? (float)sx : (float)(sx - 1));
  y = clampf(y, zero ? -1.f : 0.f, zero ? (float)sy : (float)(sy - 1));
  z = clampf(z, zero ? -1.f : 0.f, zero ? (float)sz : (float)(sz - 1));
  float fx0 = floorf(x), fy0 = floorf(y), fz0 = floorf(z);
  int i = (int)fx0, j = (int)fy0, k = (int)fz0;
  float tx = x - fx0, ty = y - fy0, tz = z - fz0;
  if (i >= 0 && j >= 0 && k >= 0 && i + 1 < sx && j + 1 < sy && k + 1 < sz) {
    size_t c = (size_t)i + (size_t)sx * ((size_t)j + (size_t)sy * k), sxy = (size_t)sx * sy;
    float c00 = lerpf(a[c], a[c + 1], tx), c10 = lerpf(a[c + sx], a[c + sx + 1], tx);
    float c01 = lerpf(a[c + sxy], a[c + sxy + 1], tx), c11 = lerpf(a[c + sxy + sx], a[c + sxy + sx + 1], tx);
    return lerpf(lerpf(c00, c10, ty), lerpf(c01, c11, ty), tz);
  }
  float v[8];
  for (int n = 0; n < 8; n++) {
    int ii = i + (n & 1), jj = j + ((n >> 1) & 1), kk = k + ((n >> 2) & 1);
    if (zero) {
      v[n] = (ii < 0 || jj < 0 || kk < 0 || ii >= sx || jj >= sy || kk >= sz)
                 ? 0.f
                 : a[(size_t)ii + (size_t)sx * ((size_t)jj + (size_t)sy * kk)];
    } else {
      ii = ii < 0 ? 0 : (ii >= sx ? sx - 1 : ii);
      jj = jj < 0 ? 0 : (jj >= sy ? sy - 1 : jj);
      kk = kk < 0 ? 0 : (kk >= sz ? sz - 1 : kk);
      v[n] = a[(size_t)ii + (size_t)sx * ((size_t)jj + (size_t)sy * kk)];
    }
  }
  return lerpf(lerpf(lerpf(v[0], v[1], tx), lerpf(v[2], v[3], tx), ty),
               lerpf(lerpf(v[4], v[5], tx), lerpf(v[6], v[7], tx), ty), tz);
}

/* like samp but also returns the min/max of the 8 contributing values (MacCormack clamp) */
static inline float samp_mm(const float *a, int sx, int sy, int sz, float x, float y, float z, int zero, float *mn,
                            float *mx) {
  float lo = zero ? -1.f : 0.f;
  x = clampf(x, lo, zero ? (float)sx : (float)(sx - 1));
  y = clampf(y, lo, zero ? (float)sy : (float)(sy - 1));
  z = clampf(z, lo, zero ? (float)sz : (float)(sz - 1));
  float fx0 = floorf(x), fy0 = floorf(y), fz0 = floorf(z);
  int i = (int)fx0, j = (int)fy0, k = (int)fz0;
  float tx = x - fx0, ty = y - fy0, tz = z - fz0;
  float v[8];
  for (int n = 0; n < 8; n++) {
    int ii = i + (n & 1), jj = j + ((n >> 1) & 1), kk = k + ((n >> 2) & 1);
    if (zero && (ii < 0 || jj < 0 || kk < 0 || ii >= sx || jj >= sy || kk >= sz)) {
      v[n] = 0.f;
    } else {
      ii = ii < 0 ? 0 : (ii >= sx ? sx - 1 : ii);
      jj = jj < 0 ? 0 : (jj >= sy ? sy - 1 : jj);
      kk = kk < 0 ? 0 : (kk >= sz ? sz - 1 : kk);
      v[n] = a[(size_t)ii + (size_t)sx * ((size_t)jj + (size_t)sy * kk)];
    }
  }
  float m0 = v[0], m1 = v[0];
  for (int n = 1; n < 8; n++) {
    m0 = fminf(m0, v[n]);
    m1 = fmaxf(m1, v[n]);
  }
  *mn = m0;
  *mx = m1;
  return lerpf(lerpf(lerpf(v[0], v[1], tx), lerpf(v[2], v[3], tx), ty),
               lerpf(lerpf(v[4], v[5], tx), lerpf(v[6], v[7], tx), ty), tz);
}

/* velocity (world units/s) at grid coordinate g (cell units; cell centre of (i,j,k) at i+.5) */
static inline void vel_at(const NvFluid *f, const float *U, const float *V, const float *W, float x, float y,
                          float z, float *out) {
  out[0] = samp(U, f->nx + 1, f->ny, f->nz, x, y - 0.5f, z - 0.5f, 0);
  out[1] = samp(V, f->nx, f->ny + 1, f->nz, x - 0.5f, y, z - 0.5f, 0);
  out[2] = samp(W, f->nx, f->ny, f->nz + 1, x - 0.5f, y - 0.5f, z, 0);
}

static inline void trace(const NvFluid *f, const float *U, const float *V, const float *W, float x, float y,
                         float z, float h, float *o) {
  /* RK2 midpoint, h = signed dt/dx */
  float v1[3], v2[3];
  vel_at(f, U, V, W, x, y, z, v1);
  vel_at(f, U, V, W, x - 0.5f * h * v1[0], y - 0.5f * h * v1[1], z - 0.5f * h * v1[2], v2);
  o[0] = x - h * v2[0];
  o[1] = y - h * v2[1];
  o[2] = z - h * v2[2];
}

/* ------------------------------------------------------------------- sparse tiles */

/* Index box of tile t for an array with extra size (ex,ey,ez): b = {i0,i1,j0,j1,k0,k1}.
 * Boxes partition the array exactly; the last tile on an axis also owns the extra face layer. */
static inline void tile_box(const NvFluid *f, int t, int ex, int ey, int ez, int *b) {
  int tx = t % f->ntx, ty = (t / f->ntx) % f->nty, tz = t / (f->ntx * f->nty);
  b[0] = tx * TS; b[1] = (tx == f->ntx - 1) ? f->nx + ex : b[0] + TS;
  b[2] = ty * TS; b[3] = (ty == f->nty - 1) ? f->ny + ey : b[2] + TS;
  b[4] = tz * TS; b[5] = (tz == f->ntz - 1) ? f->nz + ez : b[4] + TS;
}

static void zero_tile_faces(NvFluid *f, int t) {
  float *arr[3][3] = {{f->u, f->u0, f->u1}, {f->v, f->v0, f->v1}, {f->w, f->w0, f->w1}};
  int tx = t % f->ntx, ty = (t / f->ntx) % f->nty, tz = t / (f->ntx * f->nty);
  for (int comp = 0; comp < 3; comp++) {
    int b[6];
    tile_box(f, t, comp == 0, comp == 1, comp == 2, b);
    /* boundary face layer owned by an inactive neighbour on the high side */
    if (comp == 0 && tx + 1 < f->ntx && !f->t_prs[t + 1]) b[1]++;
    if (comp == 1 && ty + 1 < f->nty && !f->t_prs[t + f->ntx]) b[3]++;
    if (comp == 2 && tz + 1 < f->ntz && !f->t_prs[t + f->ntx * f->nty]) b[5]++;
    int sx = f->nx + (comp == 0), sy = f->ny + (comp == 1);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++) {
        size_t c = (size_t)b[0] + (size_t)sx * ((size_t)j + (size_t)sy * k);
        for (int q = 0; q < 3; q++) memset(arr[comp][q] + c, 0, sizeof(float) * (b[1] - b[0]));
      }
  }
}

static void hierarchy_full(NvFluid *f);
static void hierarchy_incremental(NvFluid *f);
static void active_blocks(NvFluid *f);

static inline void tile_mark_range(NvFluid *f, uint8_t *m, int i0, int i1, int j0, int j1, int k0, int k1) {
  /* cell range [i0,i1] inclusive, clipped, marks every tile it touches */
  if (i1 < 0 || j1 < 0 || k1 < 0 || i0 >= f->nx || j0 >= f->ny || k0 >= f->nz) return;
  i0 = i0 < 0 ? 0 : i0; j0 = j0 < 0 ? 0 : j0; k0 = k0 < 0 ? 0 : k0;
  i1 = i1 >= f->nx ? f->nx - 1 : i1; j1 = j1 >= f->ny ? f->ny - 1 : j1; k1 = k1 >= f->nz ? f->nz - 1 : k1;
  for (int tz = k0 / TS; tz <= k1 / TS; tz++)
    for (int ty = j0 / TS; ty <= j1 / TS; ty++)
      for (int tx = i0 / TS; tx <= i1 / TS; tx++) m[tx + f->ntx * (ty + f->nty * tz)] = 1;
}

/* Find tiles holding smoke/heat/fuel/flame, dilate (1 tile: advection, 2 tiles: pressure),
 * clear velocity in tiles that left the region, and update the solver only where tiles changed.
 * Content can only be in last step's advection tiles (motion < 1 tile per substep) or in tiles a
 * source wrote to, so only those are scanned: the cost follows the effect, not the domain. */
static void update_tiles(NvFluid *f) {
  const float eps = 1e-4f;
  int full = f->fp[FP_sparse] < 0.5f || f->gpu; /* the GPU solver is dense */
  int nc = 0;
  for (int t = 0; t < f->nt; t++) {
    if (full || f->t_adv[t] || f->t_dirty[t]) f->cand[nc++] = t;
    else f->t_cont[t] = 0;
  }
#pragma omp parallel for schedule(dynamic, 4)
  for (int q = 0; q < nc; q++) {
    int t = f->cand[q];
    if (full) { f->t_cont[t] = 1; continue; }
    int b[6], any = 0;
    tile_box(f, t, 0, 0, 0, b);
    for (int k = b[4]; k < b[5] && !any; k++)
      for (int j = b[2]; j < b[3] && !any; j++) {
        size_t c = CI(f, b[0], j, k);
        for (int i = b[0]; i < b[1]; i++, c++)
          if (f->d[c] > eps || f->T[c] > eps || f->fuel[c] > eps || f->flame[c] > eps) { any = 1; break; }
      }
    f->t_cont[t] = (uint8_t)any;
  }
  memset(f->t_dirty, 0, f->nt);
  memcpy(f->t_prev, f->t_prs, f->nt);
  memset(f->t_adv, 0, f->nt);
  memset(f->t_prs, 0, f->nt);
  /* dilation by scattering from content tiles: O(content tiles), not O(all tiles x 125) */
  for (int q = 0; q < nc; q++) {
    int t = f->cand[q];
    if (!f->t_cont[t]) continue;
    int tx = t % f->ntx, ty = (t / f->ntx) % f->nty, tz = t / (f->ntx * f->nty);
    for (int dz = -2; dz <= 2; dz++)
      for (int dy = -2; dy <= 2; dy++)
        for (int dx = -2; dx <= 2; dx++) {
          int x = tx + dx, y = ty + dy, z = tz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= f->ntx || y >= f->nty || z >= f->ntz) continue;
          int u = x + f->ntx * (y + f->nty * z);
          f->t_prs[u] = 1;
          if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && dz >= -1 && dz <= 1) f->t_adv[u] = 1;
        }
  }
  f->n_adv = f->n_prs = f->n_chg = 0;
  for (int t = 0; t < f->nt; t++) {
    if (f->t_adv[t]) f->tl_adv[f->n_adv++] = t;
    if (f->t_prs[t]) f->tl_prs[f->n_prs++] = t;
    if (f->t_prs[t] != f->t_prev[t] || f->t_force[t]) f->tl_chg[f->n_chg++] = t;
  }
  memset(f->t_force, 0, f->nt);
  if (f->n_chg) {
#pragma omp parallel for schedule(dynamic, 4)
    for (int q = 0; q < f->n_chg; q++) {
      int t = f->tl_chg[q];
      if (f->t_prev[t] && !f->t_prs[t]) zero_tile_faces(f, t);
    }
  }
  if (f->solid_dirty) {
#pragma omp parallel for schedule(static)
    for (int k = 0; k < f->nz; k++)
      for (int j = 0; j < f->ny; j++)
        for (int i = 0; i < f->nx; i++) {
          size_t c = CI(f, i, j, k);
          int t = (i / TS) + f->ntx * ((j / TS) + f->nty * (k / TS));
          f->ctype[c] = f->solid[c] ? 1 : (f->t_prs[t] ? 0 : 2);
          if (f->ctype[c]) f->phi[c] = 0.f;
        }
    hierarchy_full(f);
    f->solid_dirty = 0;
    active_blocks(f);
  } else if (f->n_chg) {
#pragma omp parallel for schedule(dynamic, 4)
    for (int q = 0; q < f->n_chg; q++) {
      int t = f->tl_chg[q], b[6];
      tile_box(f, t, 0, 0, 0, b);
      int act = f->t_prs[t];
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = CI(f, i, j, k);
            f->ctype[c] = f->solid[c] ? 1 : (act ? 0 : 2);
            if (f->ctype[c]) f->phi[c] = 0.f;
          }
    }
    hierarchy_incremental(f);
    active_blocks(f);
  }
}

API int nv_fluid_active_bbox(NvFluid *f, int *b) {
  if (f->gpu) return gpuf_active_bbox(f->gpu, b);
  /* cell bounds [i0,i1) [j0,j1) [k0,k1) of everything that can hold smoke/heat/fuel/flame */
  int lo[3] = {1 << 30, 1 << 30, 1 << 30}, hi[3] = {-1, -1, -1};
  for (int t = 0; t < f->nt; t++) {
    if (!f->t_adv[t] && !f->t_dirty[t]) continue;
    int tc[3] = {t % f->ntx, (t / f->ntx) % f->nty, t / (f->ntx * f->nty)};
    for (int a = 0; a < 3; a++) {
      if (tc[a] < lo[a]) lo[a] = tc[a];
      if (tc[a] > hi[a]) hi[a] = tc[a];
    }
  }
  if (hi[0] < 0) { memset(b, 0, 6 * sizeof(int)); return 0; }
  int n[3] = {f->nx, f->ny, f->nz};
  for (int a = 0; a < 3; a++) {
    b[2 * a] = lo[a] * TS;
    b[2 * a + 1] = (hi[a] + 1) * TS < n[a] ? (hi[a] + 1) * TS : n[a];
  }
  return 1;
}

/* cell-centred velocity of a box (from nv_fluid_active_bbox), layout [k][j][i][3] */
API void nv_fluid_cell_velocity_box(NvFluid *f, const int *b, float *out) {
  int sx = b[1] - b[0], sy = b[3] - b[2];
#pragma omp parallel for schedule(static)
  for (int k = b[4]; k < b[5]; k++)
    for (int j = b[2]; j < b[3]; j++)
      for (int i = b[0]; i < b[1]; i++) {
        size_t o = 3 * ((size_t)(i - b[0]) + (size_t)sx * ((size_t)(j - b[2]) + (size_t)sy * (k - b[4])));
        out[o + 0] = 0.5f * (f->u[UI(f, i, j, k)] + f->u[UI(f, i + 1, j, k)]);
        out[o + 1] = 0.5f * (f->v[VI(f, i, j, k)] + f->v[VI(f, i, j + 1, k)]);
        out[o + 2] = 0.5f * (f->w[WI(f, i, j, k)] + f->w[WI(f, i, j, k + 1)]);
      }
}

/* ---------------------------------------------------------------------- advection */

/* scalar MacCormack over active tiles. back/forward positions precomputed per cell. */
static void advect_scalar(NvFluid *f, const float *src, float *hat, const float *bx, const float *by,
                          const float *bz, const float *fx, const float *fy, const float *fz, int mc,
                          float *mnA, float *mxA) {
  int nx = f->nx, ny = f->ny, nz = f->nz;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], 0, 0, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          size_t c = CI(f, i, j, k);
          float mn, mx;
          hat[c] = samp_mm(src, nx, ny, nz, bx[c] - 0.5f, by[c] - 0.5f, bz[c] - 0.5f, 1, &mn, &mx);
          mnA[c] = mn;
          mxA[c] = mx;
        }
  }
  if (!mc) return;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], 0, 0, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          size_t c = CI(f, i, j, k);
          /* hat outside the active tiles is stale: the forward trace stays inside (CFL < tile) */
          float til = samp(hat, nx, ny, nz, fx[c] - 0.5f, fy[c] - 0.5f, fz[c] - 0.5f, 1);
          float val = hat[c] + 0.5f * (src[c] - til);
          mnA[c] = (val < mnA[c] || val > mxA[c]) ? hat[c] : val; /* overshoot: fall back to SL */
        }
  }
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], 0, 0, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          size_t c = CI(f, i, j, k);
          hat[c] = mnA[c];
        }
  }
}

/* MacCormack's error estimate is meaningless where a trace leaves the grid (the samples are clamped,
 * so back and forward traces don't retrace each other); there the face falls back to semi-Lagrangian.
 * Without this, faces at open boundaries amplify a little every step and a narrow domain blows up. */
static inline int outside(float x, float y, float z, int sx, int sy, int sz) {
  return x < 0.f || y < 0.f || z < 0.f || x > (float)(sx - 1) || y > (float)(sy - 1) || z > (float)(sz - 1);
}

/* advect one face component over the pressure tiles (copy-through outside the advection tiles).
 * comp 0=u 1=v 2=w. U,V,W = tracing velocity. */
static void advect_face(NvFluid *f, int comp, const float *src, float *dst, const float *U, const float *V,
                        const float *W, float dt, int mc, float *mnA, float *mxA) {
  int ex = comp == 0, ey = comp == 1, ez = comp == 2;
  int sx = f->nx + ex, sy = f->ny + ey, sz = f->nz + ez;
  float ox = ex ? 0.f : 0.5f, oy = ey ? 0.f : 0.5f, oz = ez ? 0.f : 0.5f;
  float h = dt / f->dx;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    int t = f->tl_prs[q], b[6];
    tile_box(f, t, ex, ey, ez, b);
    int act = f->t_adv[t];
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++) {
        size_t c = (size_t)b[0] + (size_t)sx * ((size_t)j + (size_t)sy * k);
        if (!act) {
          memcpy(dst + c, src + c, sizeof(float) * (b[1] - b[0]));
          continue;
        }
        for (int i = b[0]; i < b[1]; i++, c++) {
          float p[3];
          trace(f, U, V, W, i + ox, j + oy, k + oz, h, p);
          float mn, mx;
          dst[c] = samp_mm(src, sx, sy, sz, p[0] - ox, p[1] - oy, p[2] - oz, 0, &mn, &mx);
          if (outside(p[0] - ox, p[1] - oy, p[2] - oz, sx, sy, sz)) mn = INFINITY, mx = -INFINITY; /* forces SL */
          mnA[c] = mn;
          mxA[c] = mx;
        }
      }
  }
  if (!mc) return;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], ex, ey, ez, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          size_t c = (size_t)i + (size_t)sx * ((size_t)j + (size_t)sy * k);
          float p[3];
          trace(f, U, V, W, i + ox, j + oy, k + oz, -h, p);
          float til = samp(dst, sx, sy, sz, p[0] - ox, p[1] - oy, p[2] - oz, 0);
          float val = dst[c] + 0.5f * (src[c] - til);
          int sl = val < mnA[c] || val > mxA[c] || outside(p[0] - ox, p[1] - oy, p[2] - oz, sx, sy, sz);
          mnA[c] = sl ? dst[c] : val;
        }
  }
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], ex, ey, ez, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++) {
        size_t c = (size_t)b[0] + (size_t)sx * ((size_t)j + (size_t)sy * k);
        memcpy(dst + c, mnA + c, sizeof(float) * (b[1] - b[0]));
      }
  }
}

static void advect_velocity(NvFluid *f, const float *su, const float *sv, const float *sw, const float *U,
                            const float *V, const float *W, float *du, float *dv, float *dw, float dt) {
  double t0 = now_ms();
  int mc = f->fp[FP_maccormack] > 0.5f;
  advect_face(f, 0, su, du, U, V, W, dt, mc, f->tmp[0], f->tmp[1]);
  advect_face(f, 1, sv, dv, U, V, W, dt, mc, f->tmp[0], f->tmp[1]);
  advect_face(f, 2, sw, dw, U, V, W, dt, mc, f->tmp[0], f->tmp[1]);
  f->tm_adv += now_ms() - t0;
}

static void advect_scalars(NvFluid *f, const float *U, const float *V, const float *W, float dt) {
  float h = dt / f->dx;
  float *bx = f->tmp[2], *by = f->tmp[3], *bz = f->tmp[4], *fx = f->tmp[5], *fy = f->tmp[6], *fz = f->tmp[7];
  int mc = f->fp[FP_maccormack] > 0.5f;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], 0, 0, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          size_t c = CI(f, i, j, k);
          float p[3];
          trace(f, U, V, W, i + 0.5f, j + 0.5f, k + 0.5f, h, p);
          bx[c] = p[0]; by[c] = p[1]; bz[c] = p[2];
          if (mc) {
            trace(f, U, V, W, i + 0.5f, j + 0.5f, k + 0.5f, -h, p);
            fx[c] = p[0]; fy[c] = p[1]; fz[c] = p[2];
          }
        }
  }
  float *fields[4] = {f->d, f->T, f->fuel, f->flame};
  float *out = f->tmp[8];
  for (int qf = 0; qf < 4; qf++) {
    advect_scalar(f, fields[qf], out, bx, by, bz, fx, fy, fz, mc, f->tmp[0], f->tmp[1]);
    float *dst = fields[qf];
#pragma omp parallel for schedule(dynamic, 1)
    for (int q = 0; q < f->n_adv; q++) {
      int b[6];
      tile_box(f, f->tl_adv[q], 0, 0, 0, b);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = CI(f, i, j, k);
            dst[c] = out[c] > 0.f ? out[c] : 0.f;
          }
    }
  }
}

/* --------------------------------------------------------------------- solids / MG */

static inline void blk_box(const Lev *L, int bk, int *b) {
  int bx = bk % L->nbx, by = (bk / L->nbx) % L->nby, bz = bk / (L->nbx * L->nby);
  b[0] = bx * 8; b[1] = b[0] + 8 < L->nx ? b[0] + 8 : L->nx;
  b[2] = by * 8; b[3] = b[2] + 8 < L->ny ? b[2] + 8 : L->ny;
  b[4] = bz * 8; b[5] = b[4] + 8 < L->nz ? b[4] + 8 : L->nz;
}

/* Loops over every cell of a block list of one level. */
#define BLK_CELLS_BEGIN(L, list, n)                                            \
  for (int q_ = 0; q_ < (n); q_++) {                                           \
    int b_[6];                                                                 \
    blk_box((L), (list)[q_], b_);                                              \
    for (int k = b_[4]; k < b_[5]; k++)                                        \
      for (int j = b_[2]; j < b_[3]; j++) {                                    \
        size_t c = (size_t)b_[0] + (size_t)(L)->nx * ((size_t)j + (size_t)(L)->ny * k); \
        for (int i = b_[0]; i < b_[1]; i++, c++) {
#define BLK_CELLS_END \
  }                   \
  }                   \
  }

/* When most blocks of a level are active, a plain sweep beats block bookkeeping. */
static inline int lev_dense(const Lev *L) { return 2 * L->nbl >= L->nbk; }
#define DENSE_CELLS_BEGIN(L)                                                   \
  for (int k = 0; k < (L)->nz; k++)                                            \
    for (int j = 0; j < (L)->ny; j++) {                                        \
      size_t c = (size_t)(L)->nx * ((size_t)j + (size_t)(L)->ny * k);          \
      for (int i = 0; i < (L)->nx; i++, c++) {
#define DENSE_CELLS_END \
  }                     \
  }

/* type: 0 fluid, 1 solid (Neumann), 2 air (Dirichlet p = 0, i.e. outside the sparse region) */
static inline void stencil_cell(Lev *L, int closed_floor, int i, int j, int k) {
  int nx = L->nx, ny = L->ny, nz = L->nz;
  size_t c = (size_t)i + (size_t)nx * ((size_t)j + (size_t)ny * k);
  if (L->type[c]) {
    L->diag[c] = 0;
    L->nb[c] = 0;
    return;
  }
  int dg = 0, m = 0;
  const int di[6] = {-1, 1, 0, 0, 0, 0}, dj[6] = {0, 0, -1, 1, 0, 0}, dk[6] = {0, 0, 0, 0, -1, 1};
  for (int q = 0; q < 6; q++) {
    int ii = i + di[q], jj = j + dj[q], kk = k + dk[q];
    if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) {
      if (q == 4 && closed_floor) continue; /* solid floor: Neumann */
      dg++;                                 /* open boundary: Dirichlet p = 0 */
      continue;
    }
    int tn = L->type[(size_t)ii + (size_t)nx * ((size_t)jj + (size_t)ny * kk)];
    if (tn == 0) {
      dg++;
      m |= 1 << q;
    } else if (tn == 2) {
      dg++;
    }
  }
  L->diag[c] = (uint8_t)dg;
  L->nb[c] = (uint8_t)m;
}

/* coarse type from the (up to) 8 children: fluid if any child is fluid, solid if all are solid */
static inline void coarse_type_cell(const Lev *F, Lev *C, int I, int J, int K) {
  int anyf = 0, alls = 1;
  for (int n = 0; n < 8; n++) {
    int i = 2 * I + (n & 1), j = 2 * J + ((n >> 1) & 1), k = 2 * K + ((n >> 2) & 1);
    if (i >= F->nx || j >= F->ny || k >= F->nz) continue;
    int tp = F->type[(size_t)i + (size_t)F->nx * ((size_t)j + (size_t)F->ny * k)];
    if (tp == 0) anyf = 1;
    if (tp != 1) alls = 0;
  }
  C->type[(size_t)I + (size_t)C->nx * ((size_t)J + (size_t)C->ny * K)] = anyf ? 0 : (alls ? 1 : 2);
}

static void hierarchy_full(NvFluid *f) {
  f->hier_ver++;
  int cf = f->fp[FP_closed_floor] > 0.5f;
  for (int l = 0; l < f->nlev; l++) {
    Lev *L = &f->lev[l];
    if (l > 0) {
      Lev *F = &f->lev[l - 1];
#pragma omp parallel for schedule(static)
      for (int K = 0; K < L->nz; K++)
        for (int J = 0; J < L->ny; J++)
          for (int I = 0; I < L->nx; I++) coarse_type_cell(F, L, I, J, K);
    }
#pragma omp parallel for schedule(static)
    for (int k = 0; k < L->nz; k++)
      for (int j = 0; j < L->ny; j++)
        for (int i = 0; i < L->nx; i++) stencil_cell(L, cf, i, j, k);
  }
}

/* Re-type and re-stencil only the blocks above changed tiles (plus a one-block halo, because a
 * stencil reads its neighbours' types). Work is O(changed tiles), independent of the domain. */
static void hierarchy_incremental(NvFluid *f) {
  f->hier_ver++;
  int cf = f->fp[FP_closed_floor] > 0.5f;
  for (int l = 0; l < f->nlev; l++) {
    Lev *L = &f->lev[l];
    L->nml = L->nsl = 0;
    for (int q = 0; q < f->n_chg; q++) {
      int t = f->tl_chg[q];
      int bx = (t % f->ntx) >> l, by = ((t / f->ntx) % f->nty) >> l, bz = (t / (f->ntx * f->nty)) >> l;
      if (bx >= L->nbx) bx = L->nbx - 1;
      if (by >= L->nby) by = L->nby - 1;
      if (bz >= L->nbz) bz = L->nbz - 1;
      int bk = bx + L->nbx * (by + L->nby * bz);
      if (!(L->bmark[bk] & 1)) {
        L->bmark[bk] |= 1;
        L->mlist[L->nml++] = bk;
      }
    }
    for (int q = 0; q < L->nml; q++) {
      int bk = L->mlist[q];
      int bx = bk % L->nbx, by = (bk / L->nbx) % L->nby, bz = bk / (L->nbx * L->nby);
      for (int dz = -1; dz <= 1; dz++)
        for (int dy = -1; dy <= 1; dy++)
          for (int dx = -1; dx <= 1; dx++) {
            int x = bx + dx, y = by + dy, z = bz + dz;
            if (x < 0 || y < 0 || z < 0 || x >= L->nbx || y >= L->nby || z >= L->nbz) continue;
            int u = x + L->nbx * (y + L->nby * z);
            if (!(L->bmark[u] & 2)) {
              L->bmark[u] |= 2;
              L->slist[L->nsl++] = u;
            }
          }
    }
    if (l > 0) {
      Lev *F = &f->lev[l - 1];
#pragma omp parallel for schedule(dynamic, 1)
      BLK_CELLS_BEGIN(L, L->mlist, L->nml)
      (void)c;
      coarse_type_cell(F, L, i, j, k);
      BLK_CELLS_END
    }
#pragma omp parallel for schedule(dynamic, 1)
    BLK_CELLS_BEGIN(L, L->slist, L->nsl)
    (void)c;
    stencil_cell(L, cf, i, j, k);
    BLK_CELLS_END
    for (int q = 0; q < L->nsl; q++) L->bmark[L->slist[q]] = 0;
    for (int q = 0; q < L->nml; q++) L->bmark[L->mlist[q]] = 0;
  }
}

/* Per level: the blocks that contain fluid cells (= images of the pressure tiles). */
static void active_blocks(NvFluid *f) {
  for (int l = 0; l < f->nlev; l++) {
    Lev *L = &f->lev[l];
    for (int q = 0; q < L->nbl; q++) L->bact[L->blist[q]] = 0;
    L->nbl = 0;
    for (int q = 0; q < f->n_prs; q++) {
      int t = f->tl_prs[q];
      int bx = (t % f->ntx) >> l, by = ((t / f->ntx) % f->nty) >> l, bz = (t / (f->ntx * f->nty)) >> l;
      if (bx >= L->nbx) bx = L->nbx - 1;
      if (by >= L->nby) by = L->nby - 1;
      if (bz >= L->nbz) bz = L->nbz - 1;
      int bk = bx + L->nbx * (by + L->nby * bz);
      if (!L->bact[bk]) {
        L->bact[bk] = 1;
        L->blist[L->nbl++] = bk;
      }
    }
  }
}

/* red-black Gauss-Seidel over the active blocks of one level */
#define RBGS_BODY                     \
  if (((i + j + k + color) & 1)) continue; \
  int dg = L->diag[c];                \
  if (!dg) continue;                  \
  int m = L->nb[c];                   \
  float s = b[c];                     \
  if (m & 1) s += x[c - 1];           \
  if (m & 2) s += x[c + 1];           \
  if (m & 4) s += x[c - sy];          \
  if (m & 8) s += x[c + sy];          \
  if (m & 16) s += x[c - sz];         \
  if (m & 32) s += x[c + sz];         \
  x[c] = s / dg;
static void rbgs(Lev *L, int color) {
  size_t sy = L->nx, sz = (size_t)L->nx * L->ny;
  float *x = L->x;
  const float *b = L->b;
  if (lev_dense(L)) {
#pragma omp parallel for schedule(static)
    DENSE_CELLS_BEGIN(L)
    RBGS_BODY
    DENSE_CELLS_END
  } else {
#pragma omp parallel for schedule(dynamic, 1)
    BLK_CELLS_BEGIN(L, L->blist, L->nbl)
    RBGS_BODY
    BLK_CELLS_END
  }
}

static inline float stencil(const Lev *L, const float *x, size_t c) {
  int dg = L->diag[c];
  if (!dg) return 0.f;
  size_t sy = L->nx, sz = (size_t)L->nx * L->ny;
  int m = L->nb[c];
  float s = dg * x[c];
  if (m & 1) s -= x[c - 1];
  if (m & 2) s -= x[c + 1];
  if (m & 4) s -= x[c - sy];
  if (m & 8) s -= x[c + sy];
  if (m & 16) s -= x[c - sz];
  if (m & 32) s -= x[c + sz];
  return s;
}

/* Loops over every cell of the pressure tiles (level 0 of the solver). */
#define PRS_CELLS_BEGIN(f)                                                     \
  for (int q_ = 0; q_ < (f)->n_prs; q_++) {                                    \
    int b_[6];                                                                 \
    tile_box((f), (f)->tl_prs[q_], 0, 0, 0, b_);                               \
    for (int k = b_[4]; k < b_[5]; k++)                                        \
      for (int j = b_[2]; j < b_[3]; j++) {                                    \
        size_t c = CI((f), b_[0], j, k);                                       \
        for (int i = b_[0]; i < b_[1]; i++, c++) {
#define PRS_CELLS_END \
  }                   \
  }                   \
  }

/* Symmetric V-cycle (zero initial guess) used as the CG preconditioner. Every level, including
 * the coarse ones, only visits its active blocks. */
#define LEVEL_LOOP(L, ...)                                                      \
  if (lev_dense(L)) {                                                         \
    _Pragma("omp parallel for schedule(static)") DENSE_CELLS_BEGIN(L) __VA_ARGS__ DENSE_CELLS_END \
  } else {                                                                    \
    _Pragma("omp parallel for schedule(dynamic, 1)")                          \
    BLK_CELLS_BEGIN(L, (L)->blist, (L)->nbl) __VA_ARGS__ BLK_CELLS_END       \
  }

static void vcycle(NvFluid *f, int l) {
  Lev *L = &f->lev[l];
  LEVEL_LOOP(L, { (void)i; (void)j; (void)k; L->x[c] = 0.f; })
  if (l == f->nlev - 1) {
    for (int s = 0; s < 12; s++) { rbgs(L, 0); rbgs(L, 1); }
    for (int s = 0; s < 12; s++) { rbgs(L, 1); rbgs(L, 0); }
    return;
  }
  const int nu = 2;
  for (int s = 0; s < nu; s++) { rbgs(L, 0); rbgs(L, 1); }
  LEVEL_LOOP(L, { (void)i; (void)j; (void)k; L->r[c] = L->diag[c] ? L->b[c] - stencil(L, L->x, c) : 0.f; })
  Lev *C = &f->lev[l + 1];
  LEVEL_LOOP(C, {
    if (!C->diag[c]) {
      C->b[c] = 0.f;
      continue;
    }
    float s = 0.f;
    for (int q = 0; q < 8; q++) {
      int ii = 2 * i + (q & 1), jj = 2 * j + ((q >> 1) & 1), kk = 2 * k + ((q >> 2) & 1);
      if (ii >= L->nx || jj >= L->ny || kk >= L->nz) continue;
      size_t cf = (size_t)ii + (size_t)L->nx * ((size_t)jj + (size_t)L->ny * kk);
      if (L->diag[cf]) s += L->r[cf];
    }
    C->b[c] = 0.5f * s;
  })
  vcycle(f, l + 1);
  LEVEL_LOOP(L, {
    if (L->diag[c]) L->x[c] += C->x[(size_t)(i >> 1) + (size_t)C->nx * ((size_t)(j >> 1) + (size_t)C->ny * (k >> 1))];
  })
  for (int s = 0; s < nu; s++) { rbgs(L, 1); rbgs(L, 0); }
}

/* Solve A phi = b with MGPCG over the pressure tiles. Returns iterations. */
static int mgpcg(NvFluid *f) {
  Lev *L0 = &f->lev[0];
  float *x = f->phi, *r = f->cg_r, *z = f->cg_z, *p = f->cg_p, *q = f->cg_q, *b = f->cg_b;
  double bmax = 0;
#pragma omp parallel for reduction(max : bmax) schedule(dynamic, 1)
  PRS_CELLS_BEGIN(f)
  double a = fabs(b[c]);
  if (a > bmax) bmax = a;
  PRS_CELLS_END
  if (bmax < 1e-9) {
#pragma omp parallel for schedule(dynamic, 1)
    PRS_CELLS_BEGIN(f)
    x[c] = 0.f;
    PRS_CELLS_END
    f->last_iters = 0;
    f->last_res = 0;
    return 0;
  }
  double tol = f->fp[FP_cg_tol] * bmax;
  double rmax = 0;
#pragma omp parallel for reduction(max : rmax) schedule(dynamic, 1)
  PRS_CELLS_BEGIN(f)
  if (!L0->diag[c]) x[c] = 0.f;
  r[c] = L0->diag[c] ? b[c] - stencil(L0, x, c) : 0.f;
  double a = fabs(r[c]);
  if (a > rmax) rmax = a;
  PRS_CELLS_END
  int it = 0, maxit = (int)f->fp[FP_cg_iter];
  if (rmax <= tol) goto done;
  vcycle(f, 0); /* z = M^-1 r (lev0.b == r, lev0.x == z) */
  double rz = 0;
#pragma omp parallel for reduction(+ : rz) schedule(dynamic, 1)
  PRS_CELLS_BEGIN(f)
  p[c] = z[c];
  rz += (double)r[c] * z[c];
  PRS_CELLS_END
  for (it = 1; it <= maxit; it++) {
    double pq = 0;
#pragma omp parallel for reduction(+ : pq) schedule(dynamic, 1)
    PRS_CELLS_BEGIN(f)
    q[c] = stencil(L0, p, c);
    pq += (double)p[c] * q[c];
    PRS_CELLS_END
    if (fabs(pq) < 1e-30) break;
    float alpha = (float)(rz / pq);
    rmax = 0;
#pragma omp parallel for reduction(max : rmax) schedule(dynamic, 1)
    PRS_CELLS_BEGIN(f)
    x[c] += alpha * p[c];
    r[c] -= alpha * q[c];
    double a = fabs(r[c]);
    if (a > rmax) rmax = a;
    PRS_CELLS_END
    if (rmax <= tol) break;
    vcycle(f, 0);
    double rz2 = 0;
#pragma omp parallel for reduction(+ : rz2) schedule(dynamic, 1)
    PRS_CELLS_BEGIN(f)
    rz2 += (double)r[c] * z[c];
    PRS_CELLS_END
    float beta = (float)(rz2 / rz);
    rz = rz2;
#pragma omp parallel for schedule(dynamic, 1)
    PRS_CELLS_BEGIN(f)
    p[c] = z[c] + beta * p[c];
    PRS_CELLS_END
  }
done:
  f->last_iters = it;
  f->last_res = (float)(rmax / bmax);
  return it;
}

static inline int is_solid(const NvFluid *f, int i, int j, int k) {
  if (i < 0 || j < 0 || i >= f->nx || j >= f->ny || k >= f->nz) return 0;
  if (k < 0) return f->fp[FP_closed_floor] > 0.5f;
  return f->solid[CI(f, i, j, k)];
}

/* face box of a pressure tile for component comp, extended by one face layer on the high side
 * when the neighbouring tile is outside the region (that boundary face still needs the gradient). */
static inline void prs_face_box(const NvFluid *f, int t, int comp, int *b) {
  tile_box(f, t, comp == 0, comp == 1, comp == 2, b);
  int tx = t % f->ntx, ty = (t / f->ntx) % f->nty, tz = t / (f->ntx * f->nty);
  if (comp == 0 && tx + 1 < f->ntx && !f->t_prs[t + 1]) b[1]++;
  if (comp == 1 && ty + 1 < f->nty && !f->t_prs[t + f->ntx]) b[3]++;
  if (comp == 2 && tz + 1 < f->ntz && !f->t_prs[t + f->ntx * f->nty]) b[5]++;
}

static void enforce_solid_faces(NvFluid *f, float *U, float *V, float *W) {
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    int t = f->tl_prs[q], b[6];
    prs_face_box(f, t, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++)
          if (is_solid(f, i - 1, j, k) || is_solid(f, i, j, k)) U[UI(f, i, j, k)] = 0.f;
    prs_face_box(f, t, 1, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++)
          if (is_solid(f, i, j - 1, k) || is_solid(f, i, j, k)) V[VI(f, i, j, k)] = 0.f;
    prs_face_box(f, t, 2, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++)
          if (is_solid(f, i, j, k - 1) || is_solid(f, i, j, k)) W[WI(f, i, j, k)] = 0.f;
  }
}

static void project_(NvFluid *f, float *U, float *V, float *W);
static void project(NvFluid *f, float *U, float *V, float *W) {
  double t0 = now_ms();
  project_(f, U, V, W);
  f->tm_prj += now_ms() - t0;
}
static void project_(NvFluid *f, float *U, float *V, float *W) {
  int nx = f->nx, ny = f->ny, nz = f->nz;
  float dx = f->dx;
  Lev *L0 = &f->lev[0];
  enforce_solid_faces(f, U, V, W);
#pragma omp parallel for schedule(dynamic, 1)
  PRS_CELLS_BEGIN(f)
  if (!L0->diag[c]) {
    f->cg_b[c] = 0.f;
    continue;
  }
  float D = U[UI(f, i + 1, j, k)] - U[UI(f, i, j, k)] + V[VI(f, i, j + 1, k)] - V[VI(f, i, j, k)] +
            W[WI(f, i, j, k + 1)] - W[WI(f, i, j, k)];
  f->cg_b[c] = -(D - f->expn[c] * dx) * dx;
  PRS_CELLS_END
  mgpcg(f);
  const float *phi = f->phi;
  float inv = 1.f / dx;
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    int t = f->tl_prs[q], b[6];
    prs_face_box(f, t, 0, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          if (is_solid(f, i - 1, j, k) || is_solid(f, i, j, k)) continue;
          float pl = i > 0 ? phi[CI(f, i - 1, j, k)] : 0.f, pr = i < nx ? phi[CI(f, i, j, k)] : 0.f;
          U[UI(f, i, j, k)] -= (pr - pl) * inv;
        }
    prs_face_box(f, t, 1, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          if (is_solid(f, i, j - 1, k) || is_solid(f, i, j, k)) continue;
          float pl = j > 0 ? phi[CI(f, i, j - 1, k)] : 0.f, pr = j < ny ? phi[CI(f, i, j, k)] : 0.f;
          V[VI(f, i, j, k)] -= (pr - pl) * inv;
        }
    prs_face_box(f, t, 2, b);
    for (int k = b[4]; k < b[5]; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          if (is_solid(f, i, j, k - 1) || is_solid(f, i, j, k)) continue;
          float pl = k > 0 ? phi[CI(f, i, j, k - 1)] : 0.f, pr = k < nz ? phi[CI(f, i, j, k)] : 0.f;
          W[WI(f, i, j, k)] -= (pr - pl) * inv;
        }
  }
}

/* max abs divergence (diagnostics / tests) */
API float nv_fluid_max_divergence(NvFluid *f) {
  float m = 0.f;
#pragma omp parallel for reduction(max : m) schedule(static)
  for (int k = 0; k < f->nz; k++)
    for (int j = 0; j < f->ny; j++)
      for (int i = 0; i < f->nx; i++) {
        size_t c = CI(f, i, j, k);
        if (f->ctype[c]) continue; /* solid, or air outside the sparse region */
        float D = f->u[UI(f, i + 1, j, k)] - f->u[UI(f, i, j, k)] + f->v[VI(f, i, j + 1, k)] -
                  f->v[VI(f, i, j, k)] + f->w[WI(f, i, j, k + 1)] - f->w[WI(f, i, j, k)];
        D = D / f->dx - f->expn[c];
        if (fabsf(D) > m) m = fabsf(D);
      }
  return m;
}

/* ------------------------------------------------------------------------- forces */

static void add_forces_(NvFluid *f, float *U, float *V, float *W, float dt);
static void add_forces(NvFluid *f, float *U, float *V, float *W, float dt) {
  double t0 = now_ms();
  add_forces_(f, U, V, W, dt);
  f->tm_frc += now_ms() - t0;
}
/* cell-centred velocity straight from the faces (valid everywhere: faces are zero outside) */
static inline void cvel(const NvFluid *f, const float *U, const float *V, const float *W, int i, int j, int k,
                        float *o) {
  o[0] = 0.5f * (U[UI(f, i, j, k)] + U[UI(f, i + 1, j, k)]);
  o[1] = 0.5f * (V[VI(f, i, j, k)] + V[VI(f, i, j + 1, k)]);
  o[2] = 0.5f * (W[WI(f, i, j, k)] + W[WI(f, i, j, k + 1)]);
}

static inline void cvel3(const float *U, const float *V, const float *W, const NvFluid *f, int i, int j, int k,
                         float *o) {
  cvel(f, U, V, W, i, j, k, o);
}

static void add_forces_(NvFluid *f, float *U, float *V, float *W, float dt) {
  int nx = f->nx, ny = f->ny, nz = f->nz;
  float dx = f->dx;
  float bh = f->fp[FP_buoy_heat], bs = f->fp[FP_buoy_smoke];
  /* buoyancy (Boussinesq) on w faces of the advection tiles */
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
    int b[6];
    tile_box(f, f->tl_adv[q], 0, 0, 1, b);
    for (int k = b[4] < 1 ? 1 : b[4]; k < b[5] && k < nz; k++)
      for (int j = b[2]; j < b[3]; j++)
        for (int i = b[0]; i < b[1]; i++) {
          float T = 0.5f * (f->T[CI(f, i, j, k - 1)] + f->T[CI(f, i, j, k)]);
          float d = 0.5f * (f->d[CI(f, i, j, k - 1)] + f->d[CI(f, i, j, k)]);
          W[WI(f, i, j, k)] += dt * (bh * T - bs * d);
        }
  }
  /* vorticity confinement + turbulence: |w| on pressure tiles, force on advection tiles */
  float eps = f->fp[FP_vorticity], tamp = f->fp[FP_turb_amp];
  if (eps > 0.f || tamp > 0.f) {
    float *wx = f->tmp[3], *wy = f->tmp[4], *wz = f->tmp[5], *wm = f->tmp[6];
    float *Fx = f->tmp[7], *Fy = f->tmp[8], *Fz = f->tmp[9];
    size_t sy = nx, sz = (size_t)nx * ny;
    float inv2 = 0.5f / dx;
#pragma omp parallel for schedule(dynamic, 1)
    for (int q = 0; q < f->n_prs; q++) {
      int b[6];
      tile_box(f, f->tl_prs[q], 0, 0, 0, b);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = CI(f, i, j, k);
            if (i == 0 || j == 0 || k == 0 || i == nx - 1 || j == ny - 1 || k == nz - 1) {
              wx[c] = wy[c] = wz[c] = wm[c] = 0.f;
              continue;
            }
            float xm[3], xp[3], ym[3], yp[3], zm[3], zp[3];
            cvel(f, U, V, W, i - 1, j, k, xm); cvel(f, U, V, W, i + 1, j, k, xp);
            cvel(f, U, V, W, i, j - 1, k, ym); cvel(f, U, V, W, i, j + 1, k, yp);
            cvel(f, U, V, W, i, j, k - 1, zm); cvel(f, U, V, W, i, j, k + 1, zp);
            float a = ((yp[2] - ym[2]) - (zp[1] - zm[1])) * inv2;
            float bb = ((zp[0] - zm[0]) - (xp[2] - xm[2])) * inv2;
            float g = ((xp[1] - xm[1]) - (yp[0] - ym[0])) * inv2;
            wx[c] = a; wy[c] = bb; wz[c] = g;
            wm[c] = sqrtf(a * a + bb * bb + g * g);
          }
    }
    float tf = f->fp[FP_turb_freq], tt = (float)f->time * f->fp[FP_turb_speed];
    uint32_t seed = (uint32_t)f->fp[FP_seed] * 7919u + 17u;
#pragma omp parallel for schedule(dynamic, 1)
    for (int q = 0; q < f->n_prs; q++) {
      int t = f->tl_prs[q], b[6];
      tile_box(f, t, 0, 0, 0, b);
      int act = f->t_adv[t];
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = CI(f, i, j, k);
            float fx = 0.f, fy = 0.f, fz = 0.f;
            if (act && eps > 0.f && !(i == 0 || j == 0 || k == 0 || i == nx - 1 || j == ny - 1 || k == nz - 1)) {
              float gx = (wm[c + 1] - wm[c - 1]) * inv2, gy = (wm[c + sy] - wm[c - sy]) * inv2,
                    gz = (wm[c + sz] - wm[c - sz]) * inv2;
              float gl = sqrtf(gx * gx + gy * gy + gz * gz) + 1e-6f;
              gx /= gl; gy /= gl; gz /= gl;
              fx = eps * dx * (gy * wz[c] - gz * wy[c]);
              fy = eps * dx * (gz * wx[c] - gx * wz[c]);
              fz = eps * dx * (gx * wy[c] - gy * wx[c]);
            }
            if (act && tamp > 0.f) {
              float wgt = fminf(1.f, f->d[c] + f->T[c]);
              if (wgt > 1e-3f) {
                float X = f->o[0] + (i + .5f) * dx, Y = f->o[1] + (j + .5f) * dx, Z = f->o[2] + (k + .5f) * dx;
                float cn[3], cv[3];
                curl_noise(X * tf, Y * tf, Z * tf, tt, 2, seed, cn);
                /* noise stirs the gas but must not pump energy forever (inviscid: nothing removes it):
                 * the push fades out as the local speed approaches 0.5 * amplitude (m/s) */
                cvel3(U, V, W, f, i, j, k, cv);
                float sp = sqrtf(cv[0] * cv[0] + cv[1] * cv[1] + cv[2] * cv[2]);
                float lim = fmaxf(0.f, 1.f - sp / (0.5f * tamp));
                fx += tamp * wgt * lim * cn[0];
                fy += tamp * wgt * lim * cn[1];
                fz += tamp * wgt * lim * cn[2];
              }
            }
            Fx[c] = fx; Fy[c] = fy; Fz[c] = fz;
          }
    }
    /* faces between two cells of the advection region; neighbours lie in the pressure region */
#pragma omp parallel for schedule(dynamic, 1)
    for (int q = 0; q < f->n_adv; q++) {
      int b[6];
      tile_box(f, f->tl_adv[q], 0, 0, 0, b);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = CI(f, i, j, k);
            if (i > 0) U[UI(f, i, j, k)] += dt * 0.5f * (Fx[c] + Fx[c - 1]);
            if (j > 0) V[VI(f, i, j, k)] += dt * 0.5f * (Fy[c] + Fy[c - sy]);
            if (k > 0) W[WI(f, i, j, k)] += dt * 0.5f * (Fz[c] + Fz[c - sz]);
          }
    }
  }
  /* wind relaxation + velocity damping, pressure tiles only (zero stays zero outside) */
  float wd = f->fp[FP_wind_drag], vd = f->fp[FP_vel_decay];
  if (wd > 0.f || vd > 0.f) {
    float a = 1.f - expf(-wd * dt), e = expf(-vd * dt);
    float wv[3] = {f->fp[FP_wind_x], f->fp[FP_wind_y], f->fp[FP_wind_z]};
    float *arr[3] = {U, V, W};
#pragma omp parallel for schedule(dynamic, 1)
    for (int q = 0; q < f->n_prs; q++) {
      for (int comp = 0; comp < 3; comp++) {
        int b[6];
        tile_box(f, f->tl_prs[q], comp == 0, comp == 1, comp == 2, b);
        int sx = nx + (comp == 0), syy = ny + (comp == 1);
        for (int k = b[4]; k < b[5]; k++)
          for (int j = b[2]; j < b[3]; j++)
            for (int i = b[0]; i < b[1]; i++) {
              size_t c = (size_t)i + (size_t)sx * ((size_t)j + (size_t)syy * k);
              arr[comp][c] = (arr[comp][c] + (wv[comp] - arr[comp][c]) * a) * e;
            }
      }
    }
  }
}

/* ---------------------------------------------------------------------- combustion */

static void combust(NvFluid *f, float dt) {
  const float ign = f->fp[FP_ignite], br = f->fp[FP_burn_rate], hr = f->fp[FP_heat_release],
              sy = f->fp[FP_smoke_yield], ex = f->fp[FP_expansion];
  const float ec = expf(-f->fp[FP_cool] * dt), cr = f->fp[FP_cool_rad];
  const float es = expf(-f->fp[FP_smoke_decay] * dt), ef = expf(-f->fp[FP_fuel_decay] * dt),
              efl = expf(-f->fp[FP_flame_decay] * dt);
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_adv; q++) {
   int b[6];
   tile_box(f, f->tl_adv[q], 0, 0, 0, b);
   for (int k = b[4]; k < b[5]; k++)
   for (int j = b[2]; j < b[3]; j++)
   for (int i = b[0]; i < b[1]; i++) {
    size_t c = CI(f, i, j, k);
    float fu = f->fuel[c], T = f->T[c], d = f->d[c];
    float burned = 0.f;
    if (fu > 0.f && T > ign) {
      /* reaction speeds up with temperature (Arrhenius-like), limited by available fuel */
      float rate = br * fminf(4.f, 0.5f + (T - ign) * 2.f);
      burned = fminf(fu, rate * dt);
      fu -= burned;
      T += hr * burned;
      d += sy * burned;
    }
    /* expansion is capped at 40% volume growth per substep so explosions stay stable */
    f->expn[c] = fminf(ex * burned / dt, 0.4f / dt);
    float inten = br > 0.f ? burned / (br * dt) : 0.f;
    float fl = f->flame[c] * efl;
    f->flame[c] = inten > fl ? fminf(inten, 4.f) : fl;
    /* Newton cooling then exact radiative T^4 cooling: T = T / cbrt(1 + 3 c T^3 dt) */
    T *= ec;
    if (cr > 0.f && T > 0.f) T = T / cbrtf(1.f + 3.f * cr * T * T * T * dt);
    f->T[c] = T;
    f->d[c] = d * es;
    f->fuel[c] = fu * ef;
   }
  }
}

/* fastest face; faces outside the pressure tiles are zero by construction, so only those count */
static float max_speed(NvFluid *f) {
  if (f->gpu) return gpuf_max_speed(f->gpu);
  float m = 0.f;
  float *arr[3] = {f->u, f->v, f->w};
#pragma omp parallel for reduction(max : m) schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    for (int comp = 0; comp < 3; comp++) {
      int b[6];
      prs_face_box(f, f->tl_prs[q], comp, b);
      int sx = f->nx + (comp == 0), sy = f->ny + (comp == 1);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++)
            m = fmaxf(m, fabsf(arr[comp][(size_t)i + (size_t)sx * ((size_t)j + (size_t)sy * k)]));
    }
  }
  return m;
}

/* Safety net: no face may move more than 2x the CFL target in one substep. Anything faster is
 * numerical blow-up (e.g. a violent expansion against the substep cap), never real motion. */
static void clamp_velocity(NvFluid *f, float vmax) {
  float *arr[3] = {f->u, f->v, f->w};
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    for (int comp = 0; comp < 3; comp++) {
      int b[6];
      prs_face_box(f, f->tl_prs[q], comp, b);
      int sx = f->nx + (comp == 0), sy = f->ny + (comp == 1);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++)
          for (int i = b[0]; i < b[1]; i++) {
            size_t c = (size_t)i + (size_t)sx * ((size_t)j + (size_t)sy * k);
            float v = arr[comp][c];
            arr[comp][c] = v > vmax ? vmax : (v < -vmax ? -vmax : v);
          }
    }
  }
}

/* reflection bookkeeping over the pressure tiles only (faces outside are zero in every array).
 * op 0: u0 = u1;  op 1: u0 = 2 u1 - u0 */
static void faces_op(NvFluid *f, int op) {
  float *dst[3] = {f->u0, f->v0, f->w0}, *src[3] = {f->u1, f->v1, f->w1};
#pragma omp parallel for schedule(dynamic, 1)
  for (int q = 0; q < f->n_prs; q++) {
    for (int comp = 0; comp < 3; comp++) {
      int b[6];
      prs_face_box(f, f->tl_prs[q], comp, b);
      int sx = f->nx + (comp == 0), sy = f->ny + (comp == 1);
      for (int k = b[4]; k < b[5]; k++)
        for (int j = b[2]; j < b[3]; j++) {
          size_t c = (size_t)b[0] + (size_t)sx * ((size_t)j + (size_t)sy * k);
          float *d = dst[comp] + c;
          const float *s1 = src[comp] + c;
          int len = b[1] - b[0];
          if (op == 0) {
            memcpy(d, s1, sizeof(float) * len);
            continue;
          }
          for (int ii = 0; ii < len; ii++) {
            /* reflect only between two fluid cells: next to air (open boundary, outside the sparse
             * region) or a solid, reflection doubles an unconstrained correction every step and the
             * boundary faces run away, so those keep the projected value */
            int i = b[0] + ii;
            int i0 = i - (comp == 0), j0 = j - (comp == 1), k0 = k - (comp == 2);
            int inside = i0 >= 0 && j0 >= 0 && k0 >= 0 && i < f->nx && j < f->ny && k < f->nz;
            int fluid = inside && f->ctype[CI(f, i0, j0, k0)] == 0 && f->ctype[CI(f, i, j, k)] == 0;
            d[ii] = fluid ? 2.f * s1[ii] - d[ii] : s1[ii];
          }
        }
    }
  }
}

static void swapp(float **a, float **b) {
  float *t = *a;
  *a = *b;
  *b = t;
}

static void fluid_substep(NvFluid *f, float dt) {
  update_tiles(f);
  if (f->gpu) {
    if (f->gpu_hier_ver != f->hier_ver) {
      uint8_t *diag[16], *nb[16];
      for (int l = 0; l < f->nlev; l++) { diag[l] = f->lev[l].diag; nb[l] = f->lev[l].nb; }
      gpuf_set_stencils(f->gpu, f->solid, diag, nb, PERM);
      f->gpu_hier_ver = f->hier_ver;
    }
    gpuf_substep(f->gpu, f->fp, dt, f->time);
    f->time += dt;
    return;
  }
  double t0 = now_ms();
  advect_scalars(f, f->u, f->v, f->w, dt);
  double t1 = now_ms();
  combust(f, dt);
  f->tm_cmb += now_ms() - t1;
  f->tm_adv += t1 - t0;
  if (f->fp[FP_reflect] > 0.5f) {
    /* advection–reflection: half step, project, reflect, half step, project */
    advect_velocity(f, f->u, f->v, f->w, f->u, f->v, f->w, f->u1, f->v1, f->w1, 0.5f * dt);
    add_forces(f, f->u1, f->v1, f->w1, dt);
    faces_op(f, 0); /* u0 = u1 (pre-projection half step) */
    project(f, f->u1, f->v1, f->w1); /* u1 = u^{1/2} (divergence free) */
    faces_op(f, 1); /* u0 = 2 u1 - u0 (reflection) */
    advect_velocity(f, f->u0, f->v0, f->w0, f->u1, f->v1, f->w1, f->u, f->v, f->w, 0.5f * dt);
    project(f, f->u, f->v, f->w);
  } else {
    advect_velocity(f, f->u, f->v, f->w, f->u, f->v, f->w, f->u1, f->v1, f->w1, dt);
    swapp(&f->u, &f->u1); swapp(&f->v, &f->v1); swapp(&f->w, &f->w1);
    add_forces(f, f->u, f->v, f->w, dt);
    project(f, f->u, f->v, f->w);
  }
  clamp_velocity(f, 2.f * f->fp[FP_cfl] * f->dx / dt);
  f->time += dt;
}

API void nv_fluid_timings(NvFluid *f, float *o) {
  o[0] = (float)f->tm_adv; o[1] = (float)f->tm_frc; o[2] = (float)f->tm_prj; o[3] = (float)f->tm_cmb;
  f->tm_adv = f->tm_frc = f->tm_prj = f->tm_cmb = 0;
}

/* test / benchmark hook: only the scalar advection of one substep (CPU reference for the GPU path) */
API double nv_fluid_bench_advect(NvFluid *f, float dt, int iters) {
  ftz();
  update_tiles(f);
  double t0 = now_ms();
  for (int i = 0; i < iters; i++) advect_scalars(f, f->u, f->v, f->w, dt);
  return (now_ms() - t0) / iters;
}

/* diagnostics: fastest face velocity right now (CPU or GPU path) */
API float nv_fluid_max_speed(NvFluid *f) { return max_speed(f); }

API void nv_fluid_step(NvFluid *f, float dt) {
  ftz();
  double t0 = now_ms();
  f->maxvel = max_speed(f);
  int n = (int)ceilf(f->maxvel * dt / (f->fp[FP_cfl] * f->dx));
  n = n < 1 ? 1 : (n > (int)f->fp[FP_max_sub] ? (int)f->fp[FP_max_sub] : n);
  for (int s = 0; s < n; s++) fluid_substep(f, dt / n);
  f->ms = now_ms() - t0;
}

/* ------------------------------------------------------------------ fluid sources */

/* Emitter splats. mode 0 = add (values are amounts), 1 = max (values are targets).
 * Smooth kernel w = (1 - r^2/R^2)^2. vel (3n, may be NULL) pulls face velocity toward it. */
API void nv_fluid_splat(NvFluid *f, int n, const float *pos, float radius, float dens, float heat, float fuel,
                        const float *vel, float vel_amt, int mode) {
  if (f->gpu) {
    gpuf_splat(f->gpu, n, pos, radius, dens, heat, fuel, vel, vel_amt, mode);
    return;
  }
  int nx = f->nx, ny = f->ny, nz = f->nz;
  float dx = f->dx, R = fmaxf(radius, 0.75f * dx), R2 = R * R, inv = 1.f / dx;
  int rr = (int)ceilf(R * inv) + 1;
  for (int p = 0; p < n; p++) {
    int ci = (int)floorf((pos[3 * p] - f->o[0]) * inv), cj = (int)floorf((pos[3 * p + 1] - f->o[1]) * inv),
        ck = (int)floorf((pos[3 * p + 2] - f->o[2]) * inv);
    tile_mark_range(f, f->t_dirty, ci - rr, ci + rr, cj - rr, cj + rr, ck - rr, ck + rr);
  }
#pragma omp parallel for schedule(dynamic, 1)
  for (int k = 0; k < nz; k++) {
    float zc = f->o[2] + (k + 0.5f) * dx;
    for (int p = 0; p < n; p++) {
      float px = pos[3 * p], py = pos[3 * p + 1], pz = pos[3 * p + 2];
      float dz = zc - pz;
      if (dz * dz > R2) continue;
      int ci = (int)floorf((px - f->o[0]) * inv), cj = (int)floorf((py - f->o[1]) * inv);
      for (int j = cj - rr; j <= cj + rr; j++) {
        if (j < 0 || j >= ny) continue;
        float dy = f->o[1] + (j + 0.5f) * dx - py;
        for (int i = ci - rr; i <= ci + rr; i++) {
          if (i < 0 || i >= nx) continue;
          float dxx = f->o[0] + (i + 0.5f) * dx - px;
          float q = (dxx * dxx + dy * dy + dz * dz) / R2;
          if (q >= 1.f) continue;
          float w = (1.f - q) * (1.f - q);
          size_t c = CI(f, i, j, k);
          if (f->solid[c]) continue;
          if (mode == 0) {
            f->d[c] += dens * w;
            f->T[c] += heat * w;
            f->fuel[c] += fuel * w;
          } else {
            f->d[c] = fmaxf(f->d[c], dens * w);
            f->T[c] = fmaxf(f->T[c], heat * w);
            f->fuel[c] = fmaxf(f->fuel[c], fuel * w);
          }
          if (vel && vel_amt > 0.f) {
            float a = fminf(1.f, w * vel_amt);
            /* faces owned by this cell: low faces of i, j, k (each face written by one cell) */
            float *U = f->u, *V = f->v, *W = f->w;
            U[UI(f, i, j, k)] += (vel[3 * p] - U[UI(f, i, j, k)]) * a;
            V[VI(f, i, j, k)] += (vel[3 * p + 1] - V[VI(f, i, j, k)]) * a;
            W[WI(f, i, j, k)] += (vel[3 * p + 2] - W[WI(f, i, j, k)]) * a;
          }
        }
      }
    }
  }
}

/* trilinear deposit (particles -> grid), bucketed by k-plane so no atomics are needed.
 * amt is 3 floats per point: smoke, heat, fuel (already multiplied by dt). */
static void fluid_deposit(NvFluid *f, int n, const float *pos, const float *amt) {
  if (n <= 0) return;
  if (f->gpu) {
    gpuf_deposit(f->gpu, n, pos, amt);
    return;
  }
  int nx = f->nx, ny = f->ny, nz = f->nz;
  float inv = 1.f / f->dx;
  int *kb = (int *)malloc(sizeof(int) * n);
  int *cnt = (int *)calloc(nz + 1, sizeof(int));
  int *order = (int *)malloc(sizeof(int) * n);
  for (int p = 0; p < n; p++) {
    float gz = (pos[3 * p + 2] - f->o[2]) * inv - 0.5f;
    int k = (int)floorf(gz);
    kb[p] = (k < -1 || k >= nz) ? -2 : k;
    if (kb[p] >= -1) {
      cnt[kb[p] + 1]++;
      int i = (int)floorf((pos[3 * p] - f->o[0]) * inv - 0.5f), j = (int)floorf((pos[3 * p + 1] - f->o[1]) * inv - 0.5f);
      tile_mark_range(f, f->t_dirty, i, i + 1, j, j + 1, k, k + 1);
    }
  }
  int *start = (int *)malloc(sizeof(int) * (nz + 2));
  start[0] = 0;
  for (int k = 0; k <= nz; k++) start[k + 1] = start[k] + cnt[k];
  int *fill = (int *)calloc(nz + 1, sizeof(int));
  for (int p = 0; p < n; p++)
    if (kb[p] >= -1) order[start[kb[p] + 1] + fill[kb[p] + 1]++] = p;
#pragma omp parallel for schedule(dynamic, 1)
  for (int k = 0; k < nz; k++) {
    /* contributions from bucket k (weight 1-tz) and bucket k-1 (weight tz) */
    for (int b = k - 1; b <= k; b++) {
      int bi = b + 1;
      for (int q = start[bi]; q < start[bi + 1]; q++) {
        int p = order[q];
        float gx = (pos[3 * p] - f->o[0]) * inv - 0.5f, gy = (pos[3 * p + 1] - f->o[1]) * inv - 0.5f,
              gz = (pos[3 * p + 2] - f->o[2]) * inv - 0.5f;
        float tz = gz - floorf(gz);
        float wz = (b == k) ? 1.f - tz : tz;
        int i0 = (int)floorf(gx), j0 = (int)floorf(gy);
        float tx = gx - i0, ty = gy - j0;
        for (int dj = 0; dj < 2; dj++) {
          int j = j0 + dj;
          if (j < 0 || j >= ny) continue;
          float wy = dj ? ty : 1.f - ty;
          for (int di = 0; di < 2; di++) {
            int i = i0 + di;
            if (i < 0 || i >= nx) continue;
            float w = wz * wy * (di ? tx : 1.f - tx);
            size_t c = CI(f, i, j, k);
            f->d[c] += amt[3 * p] * w;
            f->T[c] += amt[3 * p + 1] * w;
            f->fuel[c] += amt[3 * p + 2] * w;
          }
        }
      }
    }
  }
  free(kb); free(cnt); free(order); free(start); free(fill);
}

/* =================================================================== particle system */

typedef struct {
  float *x, *y, *z, *vx, *vy, *vz, *age, *life, *temp, *size, *cr, *cg, *cb;
  uint32_t *id;
  uint8_t *kind, *gen;
  int n, cap;
} PB;

typedef struct NvSys {
  PB p, q, alt;
  float kp[MAXK][KP_COUNT];
  int nk;
  float sp[SP_COUNT];
  Collider col[MAXCOL];
  int ncol;
  Force frc[MAXFRC];
  int nfrc;
  NvFluid *fluid;
  uint32_t next_id, stepno;
  double time, ms;
  /* scratch */
  uint16_t *ev_trail, *ev_death;
  uint8_t *ev_split, *ev_hit, *dead;
  uint32_t *cnt, *off;
  int scap;
  float *dep_pos, *dep_amt;
  int dep_cap;
  Sdf sdf[MAXSDF];
  /* turbulence baked on a grid around the particles (used when far cheaper than per-particle noise) */
  float *tg;
  size_t tg_cap;
  int tg_n[3];
  float tg_o[3], tg_h;
  int tg_mode; /* -1 never, 0 auto, 1 always (tests) */
  int tg_used, tg_on;
} NvSys;

#define PB_FLOATS(X) X(x) X(y) X(z) X(vx) X(vy) X(vz) X(age) X(life) X(temp) X(size) X(cr) X(cg) X(cb)

/* memcpy split across threads (also spreads first-touch page faults over all cores) */
static void pmemcpy(void *dst, const void *src, size_t bytes) {
  if (bytes < (1u << 20)) {
    memcpy(dst, src, bytes);
    return;
  }
  const size_t chunk = 1u << 18;
  int nchunk = (int)((bytes + chunk - 1) / chunk);
#pragma omp parallel for schedule(static)
  for (int q = 0; q < nchunk; q++) {
    size_t o = (size_t)q * chunk, len = o + chunk > bytes ? bytes - o : chunk;
    memcpy((char *)dst + o, (const char *)src + o, len);
  }
}

static void *grow(void *old, size_t used, size_t cap) {
  void *p = malloc(cap ? cap : 1);
  if (old && used) pmemcpy(p, old, used);
  free(old);
  return p;
}

static void pb_reserve(PB *b, int cap) {
  if (cap <= b->cap) return;
  int nc = b->cap ? b->cap : 1024;
  while (nc < cap) nc = nc + nc / 2;
  size_t n = (size_t)b->n;
#define RE(f) b->f = (float *)grow(b->f, sizeof(float) * n, sizeof(float) * (size_t)nc);
  PB_FLOATS(RE)
#undef RE
  b->id = (uint32_t *)grow(b->id, sizeof(uint32_t) * n, sizeof(uint32_t) * (size_t)nc);
  b->kind = (uint8_t *)grow(b->kind, n, (size_t)nc);
  b->gen = (uint8_t *)grow(b->gen, n, (size_t)nc);
  b->cap = nc;
}

/* append all of Q to the end of D (D must have room) */
static void pb_append(PB *D, int at, const PB *Q) {
  size_t m = (size_t)Q->n;
#define AP(f) pmemcpy(D->f + at, Q->f, sizeof(float) * m);
  PB_FLOATS(AP)
#undef AP
  pmemcpy(D->id + at, Q->id, sizeof(uint32_t) * m);
  pmemcpy(D->kind + at, Q->kind, m);
  pmemcpy(D->gen + at, Q->gen, m);
}
static void pb_free(PB *b) {
#define FR(f) free(b->f);
  PB_FLOATS(FR)
#undef FR
  free(b->id); free(b->kind); free(b->gen);
  memset(b, 0, sizeof *b);
}
static inline void pb_copy(PB *d, int di, const PB *s, int si) {
#define CP(f) d->f[di] = s->f[si];
  PB_FLOATS(CP)
#undef CP
  d->id[di] = s->id[si];
  d->kind[di] = s->kind[si];
  d->gen[di] = s->gen[si];
}

API NvSys *nv_sys_new(void) {
  bb_init();
  NvSys *s = (NvSys *)calloc(1, sizeof(NvSys));
  memcpy(s->sp, sys_defs, sizeof sys_defs);
  for (int k = 0; k < MAXK; k++) memcpy(s->kp[k], kind_defs, sizeof kind_defs);
  s->nk = 1;
  return s;
}

API void nv_sys_free(NvSys *s) {
  if (!s) return;
  pb_free(&s->p);
  pb_free(&s->q);
  pb_free(&s->alt);
  free(s->ev_trail); free(s->ev_death); free(s->ev_split); free(s->ev_hit); free(s->dead);
  free(s->cnt); free(s->off); free(s->dep_pos); free(s->dep_amt);
  for (int i = 0; i < MAXSDF; i++) free(s->sdf[i].d);
  free(s->tg);
  free(s);
}

API void nv_sys_reset(NvSys *s) {
  s->p.n = 0;
  s->q.n = 0;
  s->next_id = 0;
  s->stepno = 0;
  s->time = 0;
}

API void nv_sys_set_params(NvSys *s, const float *p) { memcpy(s->sp, p, sizeof s->sp); }
API void nv_sys_set_kinds(NvSys *s, int nk, const float *p) {
  s->nk = nk < 1 ? 1 : (nk > MAXK ? MAXK : nk);
  for (int k = 0; k < s->nk; k++) memcpy(s->kp[k], p + (size_t)k * KP_COUNT, sizeof(float) * KP_COUNT);
}
static void collider_aabb_s(const NvSys *s, const Collider *C, float *lo, float *hi);
static void mark_voxelize(NvSys *s, const float *lo, const float *hi);
API void nv_sys_set_fluid(NvSys *s, NvFluid *f) {
  s->fluid = f;
  for (int c = 0; f && c < s->ncol; c++) { /* a new grid needs every collider stamped once */
    float lo[3], hi[3];
    collider_aabb_s(s, &s->col[c], lo, hi);
    mark_voxelize(s, lo, hi);
  }
}
API int nv_sys_count(NvSys *s) { return s->p.n; }

/* collider record: type, m[12], mi[12], ext[3], vel[3] = 31 floats */
static void collider_aabb_s(const NvSys *s, const Collider *C, float *lo, float *hi);
static void mark_voxelize(NvSys *s, const float *lo, const float *hi);

/* Colliders are re-sent every frame; the grid is only re-voxelized when one actually changed,
 * and only inside the boxes covering their old and new positions. */
API void nv_sys_set_colliders(NvSys *s, int n, const float *d) {
  Collider nc[MAXCOL];
  memset(nc, 0, sizeof nc);
  int cnt = n > MAXCOL ? MAXCOL : n;
  for (int c = 0; c < cnt; c++) {
    const float *r = d + c * 31;
    Collider *C = &nc[c];
    C->type = (int)r[0];
    memcpy(C->m, r + 1, 12 * 4);
    memcpy(C->mi, r + 13, 12 * 4);
    memcpy(C->ext, r + 25, 3 * 4);
    memcpy(C->vel, r + 28, 3 * 4);
    float sm = 1e30f;
    for (int j = 0; j < 3; j++) {
      float l = sqrtf(C->mi[j] * C->mi[j] + C->mi[4 + j] * C->mi[4 + j] + C->mi[8 + j] * C->mi[8 + j]);
      sm = fminf(sm, l);
    }
    C->smin = sm;
    float gz = sqrtf(C->m[8] * C->m[8] + C->m[9] * C->m[9] + C->m[10] * C->m[10]);
    C->pinv = gz > 0.f ? 1.f / gz : 1.f;
  }
  /* geometry only (velocity changes alone do not move solid cells) */
  int same = cnt == s->ncol;
  for (int c = 0; same && c < cnt; c++)
    same = nc[c].type == s->col[c].type && !memcmp(nc[c].m, s->col[c].m, sizeof nc[c].m) &&
           !memcmp(nc[c].ext, s->col[c].ext, sizeof nc[c].ext);
  if (!same && s->fluid) {
    for (int c = 0; c < s->ncol; c++) { /* old positions: clear */
      float lo[3], hi[3];
      collider_aabb_s(s, &s->col[c], lo, hi);
      mark_voxelize(s, lo, hi);
    }
    for (int c = 0; c < cnt; c++) { /* new positions: fill */
      float lo[3], hi[3];
      collider_aabb_s(s, &nc[c], lo, hi);
      mark_voxelize(s, lo, hi);
    }
  }
  memcpy(s->col, nc, sizeof nc);
  s->ncol = cnt;
}

/* Upload a mesh collider's signed distance field into slot `slot` (local space of the collider). */
API int nv_sys_set_sdf(NvSys *s, int slot, int nx, int ny, int nz, float ox, float oy, float oz, float dx,
                       const float *d) {
  if (slot < 0 || slot >= MAXSDF || nx < 2 || ny < 2 || nz < 2) return -1;
  Sdf *S = &s->sdf[slot];
  size_t n = (size_t)nx * ny * nz;
  free(S->d);
  S->d = (float *)malloc(n * sizeof(float));
  memcpy(S->d, d, n * sizeof(float));
  S->nx = nx; S->ny = ny; S->nz = nz;
  S->o[0] = ox; S->o[1] = oy; S->o[2] = oz;
  S->dx = dx;
  /* any collider using this slot changed shape: re-voxelize it */
  for (int c = 0; c < s->ncol; c++)
    if (s->col[c].type == 3 && (int)s->col[c].ext[0] == slot) {
      float lo[3], hi[3];
      collider_aabb_s(s, &s->col[c], lo, hi);
      mark_voxelize(s, lo, hi);
    }
  return 0;
}

/* force record: type, pos[3], axis[3], strength, radius, freq, falloff = 11 floats */
API void nv_sys_set_forces(NvSys *s, int n, const float *d) {
  s->nfrc = n > MAXFRC ? MAXFRC : n;
  for (int c = 0; c < s->nfrc; c++) {
    const float *r = d + c * 11;
    Force *F = &s->frc[c];
    F->type = (int)r[0];
    memcpy(F->pos, r + 1, 12);
    memcpy(F->axis, r + 4, 12);
    F->strength = r[7];
    F->radius = r[8];
    F->freq = r[9];
    F->falloff = r[10];
  }
}

static inline void xf(const float *m, const float *p, float *o) {
  o[0] = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  o[1] = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7];
  o[2] = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
}

/* inside test. returns 1 and fills world push-out point + normal if inside */
static inline float sdf_at(const Sdf *S, float x, float y, float z) {
  x = clampf(x, 0.f, S->nx - 1.001f); y = clampf(y, 0.f, S->ny - 1.001f); z = clampf(z, 0.f, S->nz - 1.001f);
  int i = (int)x, j = (int)y, k = (int)z;
  float tx = x - i, ty = y - j, tz = z - k;
  size_t sx = 1, sy = S->nx, sz = (size_t)S->nx * S->ny, c = i + sy * j + sz * k;
  const float *d = S->d;
  float c00 = lerpf(d[c], d[c + sx], tx), c10 = lerpf(d[c + sy], d[c + sy + sx], tx);
  float c01 = lerpf(d[c + sz], d[c + sz + sx], tx), c11 = lerpf(d[c + sz + sy], d[c + sz + sy + sx], tx);
  return lerpf(lerpf(c00, c10, ty), lerpf(c01, c11, ty), tz);
}

static int collider_test(const NvSys *s, const Collider *C, const float *p, float *outp, float *n) {
  float l[3];
  xf(C->m, p, l);
  float ln[3] = {0, 0, 0}, lp[3] = {l[0], l[1], l[2]};
  if (C->type == 0) {
    if (l[2] >= 0.f) return 0;
    lp[2] = 0.f;
    ln[2] = 1.f;
  } else if (C->type == 1) {
    float r = C->ext[0], d = sqrtf(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
    if (d >= r) return 0;
    if (d < 1e-8f) { l[2] = 1e-4f; d = 1e-4f; }
    for (int k = 0; k < 3; k++) {
      ln[k] = l[k] / d;
      lp[k] = ln[k] * r;
    }
  } else if (C->type == 3) {
    int slot = (int)C->ext[0];
    if (slot < 0 || slot >= MAXSDF || !s->sdf[slot].d) return 0;
    const Sdf *S = &s->sdf[slot];
    float gx = (l[0] - S->o[0]) / S->dx, gy = (l[1] - S->o[1]) / S->dx, gz = (l[2] - S->o[2]) / S->dx;
    if (gx < 0.f || gy < 0.f || gz < 0.f || gx > S->nx - 1 || gy > S->ny - 1 || gz > S->nz - 1) return 0;
    float d = sdf_at(S, gx, gy, gz);
    if (d >= 0.f) return 0;
    const float e = 0.5f;
    float g[3] = {sdf_at(S, gx + e, gy, gz) - sdf_at(S, gx - e, gy, gz),
                  sdf_at(S, gx, gy + e, gz) - sdf_at(S, gx, gy - e, gz),
                  sdf_at(S, gx, gy, gz + e) - sdf_at(S, gx, gy, gz - e)};
    float gl = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    if (gl < 1e-12f) { g[0] = 0; g[1] = 0; g[2] = 1; gl = 1; }
    for (int k = 0; k < 3; k++) {
      ln[k] = g[k] / gl;
      lp[k] = l[k] - d * ln[k]; /* step out along the distance gradient to the surface */
    }
  } else {
    float best = 1e30f;
    int ax = -1;
    for (int k = 0; k < 3; k++) {
      float pen = C->ext[k] - fabsf(l[k]);
      if (pen <= 0.f) return 0;
      if (pen < best) { best = pen; ax = k; }
    }
    float sg = l[ax] >= 0.f ? 1.f : -1.f;
    lp[ax] = sg * C->ext[ax];
    ln[ax] = sg;
  }
  xf(C->mi, lp, outp);
  /* normal: transpose of world->local applied to local normal */
  n[0] = C->m[0] * ln[0] + C->m[4] * ln[1] + C->m[8] * ln[2];
  n[1] = C->m[1] * ln[0] + C->m[5] * ln[1] + C->m[9] * ln[2];
  n[2] = C->m[2] * ln[0] + C->m[6] * ln[1] + C->m[10] * ln[2];
  float nl = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) + 1e-12f;
  n[0] /= nl; n[1] /= nl; n[2] /= nl;
  return 1;
}

/* conservative world AABB of a collider (planes are unbounded) */
/* Signed distance to a collider, never larger than the true world distance (safe for sphere tracing). */
static float collider_dist(const NvSys *s, const Collider *C, const float *p) {
  float l[3];
  xf(C->m, p, l);
  if (C->type == 0) return l[2] * C->pinv;
  if (C->type == 1) return (sqrtf(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]) - C->ext[0]) * C->smin;
  if (C->type == 2) {
    float q[3], o = 0.f, mx = -1e30f;
    for (int a = 0; a < 3; a++) {
      q[a] = fabsf(l[a]) - C->ext[a];
      o += q[a] > 0.f ? q[a] * q[a] : 0.f;
      mx = fmaxf(mx, q[a]);
    }
    return (sqrtf(o) + fminf(mx, 0.f)) * C->smin;
  }
  int slot = (int)C->ext[0];
  if (slot < 0 || slot >= MAXSDF || !s->sdf[slot].d) return 1e30f;
  const Sdf *S = &s->sdf[slot];
  int nn[3] = {S->nx, S->ny, S->nz};
  float out = 0.f, g[3];
  for (int a = 0; a < 3; a++) {
    float lo = S->o[a], hi = S->o[a] + (nn[a] - 1) * S->dx;
    float e = l[a] < lo ? lo - l[a] : (l[a] > hi ? l[a] - hi : 0.f);
    out += e * e;
    g[a] = (clampf(l[a], lo, hi) - S->o[a]) / S->dx;
  }
  float d = sdf_at(S, g[0], g[1], g[2]);
  if (out > 0.f) d = fmaxf(d, 0.f) + sqrtf(out); /* outside the baked box: box distance is a lower bound */
  return d * C->smin;
}

static void collider_aabb_s(const NvSys *s, const Collider *C, float *lo, float *hi) {
  if (C->type == 0) {
    for (int a = 0; a < 3; a++) { lo[a] = -1e30f; hi[a] = 1e30f; }
    return;
  }
  float e0[3], e1[3];
  if (C->type == 3) {
    int slot = (int)C->ext[0];
    const Sdf *S = (slot >= 0 && slot < MAXSDF) ? &s->sdf[slot] : NULL;
    if (!S || !S->d) {
      for (int a = 0; a < 3; a++) { lo[a] = 1e30f; hi[a] = -1e30f; }
      return;
    }
    int nn[3] = {S->nx, S->ny, S->nz};
    for (int a = 0; a < 3; a++) { e0[a] = S->o[a]; e1[a] = S->o[a] + (nn[a] - 1) * S->dx; }
  } else {
    float e[3] = {C->ext[0], C->type == 1 ? C->ext[0] : C->ext[1], C->type == 1 ? C->ext[0] : C->ext[2]};
    for (int a = 0; a < 3; a++) { e0[a] = -e[a]; e1[a] = e[a]; }
  }
  for (int a = 0; a < 3; a++) { lo[a] = 1e30f; hi[a] = -1e30f; }
  for (int n = 0; n < 8; n++) {
    float p[3] = {(n & 1) ? e1[0] : e0[0], (n & 2) ? e1[1] : e0[1], (n & 4) ? e1[2] : e0[2]}, w[3];
    xf(C->mi, p, w);
    for (int a = 0; a < 3; a++) { lo[a] = fminf(lo[a], w[a]); hi[a] = fmaxf(hi[a], w[a]); }
  }
}

static void mark_voxelize(NvSys *s, const float *lo, const float *hi) {
  NvFluid *f = s->fluid;
  if (!f) return;
  int n[3] = {f->nx, f->ny, f->nz}, b[6];
  for (int a = 0; a < 3; a++) {
    float g0 = (lo[a] - f->o[a]) / f->dx - 1.f, g1 = (hi[a] - f->o[a]) / f->dx + 1.f;
    g0 = clampf(g0, 0.f, (float)n[a]);
    g1 = clampf(g1, 0.f, (float)n[a]);
    b[2 * a] = (int)floorf(g0);
    b[2 * a + 1] = (int)ceilf(g1);
    if (b[2 * a + 1] <= b[2 * a]) return; /* outside the domain */
  }
  if (!f->vox_pending) {
    memcpy(f->vox_box, b, sizeof b);
  } else {
    for (int a = 0; a < 3; a++) {
      if (b[2 * a] < f->vox_box[2 * a]) f->vox_box[2 * a] = b[2 * a];
      if (b[2 * a + 1] > f->vox_box[2 * a + 1]) f->vox_box[2 * a + 1] = b[2 * a + 1];
    }
  }
  f->vox_pending = 1;
}

/* re-voxelize only the pending box, then flag those tiles so the solver re-types them */
static void voxelize_pending(NvSys *s) {
  NvFluid *f = s->fluid;
  if (!f || !f->vox_pending) return;
  const int *b = f->vox_box;
#pragma omp parallel for schedule(static)
  for (int k = b[4]; k < b[5]; k++)
    for (int j = b[2]; j < b[3]; j++)
      for (int i = b[0]; i < b[1]; i++) {
        float p[3] = {f->o[0] + (i + .5f) * f->dx, f->o[1] + (j + .5f) * f->dx, f->o[2] + (k + .5f) * f->dx};
        uint8_t sol = 0;
        for (int c = 0; c < s->ncol && !sol; c++) {
          float op[3], nn[3];
          if (collider_test(s, &s->col[c], p, op, nn)) sol = 1;
        }
        f->solid[CI(f, i, j, k)] = sol;
      }
  tile_mark_range(f, f->t_force, b[0], b[1] - 1, b[2], b[3] - 1, b[4], b[5] - 1);
  f->vox_pending = 0;
}

static void hue_rotate(float *c, float ang) {
  /* rotate rgb around the grey axis (Rodrigues) */
  float cs = cosf(ang), sn = sinf(ang), k = 0.57735027f;
  float r = c[0], g = c[1], b = c[2];
  float dot = (r + g + b) * k * (1.f - cs);
  float cx = k * (g - b), cy = k * (b - r), cz = k * (r - g); /* k x c */
  c[0] = fmaxf(0.f, r * cs + cx * sn + k * dot);
  c[1] = fmaxf(0.f, g * cs + cy * sn + k * dot);
  c[2] = fmaxf(0.f, b * cs + cz * sn + k * dot);
}

static void init_particle(const NvSys *s, PB *b, int i, int k, const float *pos, const float *vel,
                          const float *prgb, int gen, uint32_t id) {
  const float *K = s->kp[k];
  uint32_t sd = (uint32_t)s->sp[SP_seed] * 2654435761u;
  b->x[i] = pos[0]; b->y[i] = pos[1]; b->z[i] = pos[2];
  b->vx[i] = vel[0]; b->vy[i] = vel[1]; b->vz[i] = vel[2];
  b->age[i] = 0.f;
  b->life[i] = fmaxf(1e-3f, lerpf(K[KP_life_min], K[KP_life_max], u01(h3(id, sd, 11))));
  b->temp[i] = K[KP_temp0] + K[KP_temp_var] * (2.f * u01(h3(id, sd, 12)) - 1.f);
  b->size[i] = fmaxf(0.f, 1.f + K[KP_size_var] * (2.f * u01(h3(id, sd, 13)) - 1.f));
  float c[3];
  if (prgb && K[KP_inherit_color] > 0.5f) {
    c[0] = prgb[0]; c[1] = prgb[1]; c[2] = prgb[2];
  } else {
    c[0] = K[KP_c0r]; c[1] = K[KP_c0g]; c[2] = K[KP_c0b];
    float hr = K[KP_hue_random], cv = K[KP_color_var];
    if (hr > 0.f) hue_rotate(c, hr * 6.2831853f * u01(h3(id, sd, 14)));
    if (cv > 0.f) {
      hue_rotate(c, cv * 1.2f * (2.f * u01(h3(id, sd, 15)) - 1.f));
      float br = 1.f + cv * (2.f * u01(h3(id, sd, 16)) - 1.f);
      c[0] *= br; c[1] *= br; c[2] *= br;
    }
  }
  b->cr[i] = c[0]; b->cg[i] = c[1]; b->cb[i] = c[2];
  b->id[i] = id;
  b->kind[i] = (uint8_t)k;
  b->gen[i] = (uint8_t)(gen > 255 ? 255 : gen);
}

/* Emission from Blender emitters. preage spreads births across the frame (sub-frame accuracy). */
API int nv_emit(NvSys *s, int kind, int n, const float *pos, const float *vel, const float *preage) {
  if (kind < 0 || kind >= s->nk || n <= 0) return 0;
  int room = (int)s->sp[SP_max_particles] - s->p.n;
  if (room <= 0) return 0;
  if (n > room) n = room;
  pb_reserve(&s->p, s->p.n + n);
  int base = s->p.n;
  uint32_t id0 = s->next_id;
  float gx = s->sp[SP_gx] * s->kp[kind][KP_gravity], gy = s->sp[SP_gy] * s->kp[kind][KP_gravity],
        gz = s->sp[SP_gz] * s->kp[kind][KP_gravity];
#pragma omp parallel for schedule(static)
  for (int q = 0; q < n; q++) {
    float p[3] = {pos[3 * q], pos[3 * q + 1], pos[3 * q + 2]};
    float v[3] = {vel[3 * q], vel[3 * q + 1], vel[3 * q + 2]};
    float pa = preage ? preage[q] : 0.f;
    if (pa > 0.f) {
      p[0] += v[0] * pa + 0.5f * gx * pa * pa;
      p[1] += v[1] * pa + 0.5f * gy * pa * pa;
      p[2] += v[2] * pa + 0.5f * gz * pa * pa;
      v[0] += gx * pa; v[1] += gy * pa; v[2] += gz * pa;
    }
    init_particle(s, &s->p, base + q, kind, p, v, NULL, 0, id0 + (uint32_t)q);
    s->p.age[base + q] = pa;
  }
  s->p.n += n;
  s->next_id += (uint32_t)n;
  return n;
}

static void scratch_reserve(NvSys *s, int n) {
  if (n <= s->scap) return;
  int c = n + n / 2 + 1024;
  s->ev_trail = (uint16_t *)realloc(s->ev_trail, sizeof(uint16_t) * c);
  s->ev_death = (uint16_t *)realloc(s->ev_death, sizeof(uint16_t) * c);
  s->ev_split = (uint8_t *)realloc(s->ev_split, c);
  s->ev_hit = (uint8_t *)realloc(s->ev_hit, c);
  s->dead = (uint8_t *)realloc(s->dead, c);
  s->cnt = (uint32_t *)realloc(s->cnt, sizeof(uint32_t) * c);
  s->off = (uint32_t *)realloc(s->off, sizeof(uint32_t) * (c + 1));
  s->scap = c;
}

/* exclusive parallel prefix sum; returns total */
static uint64_t scan(const uint32_t *in, uint32_t *out, int n) {
  int nt = omp_get_max_threads();
  uint64_t part[257] = {0};
  if (nt > 256) nt = 256;
#pragma omp parallel num_threads(nt)
  {
    int t = omp_get_thread_num(), T = nt;
    int a = (int)((int64_t)n * t / T), b = (int)((int64_t)n * (t + 1) / T);
    uint64_t sum = 0;
    for (int i = a; i < b; i++) sum += in[i];
    part[t + 1] = sum;
#pragma omp barrier
#pragma omp single
    for (int i = 1; i <= T; i++) part[i] += part[i - 1];
    uint64_t acc = part[t];
    for (int i = a; i < b; i++) {
      out[i] = (uint32_t)acc;
      acc += in[i];
    }
  }
  return part[nt];
}

/* burst direction for pattern; returns direction (not necessarily unit; length = speed factor) */
static void pattern_dir(int pat, int j, int cnt, uint32_t pid, uint32_t sd, const float *pv, float *d) {
  uint32_t hj = h3(pid, (uint32_t)j, sd ^ 0xB5297A4Du);
  float jit = 0.06f;
  switch (pat) {
    default:
    case 0: { /* sphere: Fibonacci lattice, randomly rotated per parent (even star spacing like real shells) */
      float z = 1.f - 2.f * (j + 0.5f) / (float)cnt, r = sqrtf(fmaxf(0.f, 1.f - z * z));
      float a = j * 2.3999632f;
      float v[3] = {r * cosf(a), r * sinf(a), z};
      float ax[3];
      rand_dir(h3(pid, sd, 0x51), ax);
      float ang = 6.2831853f * u01(h3(pid, sd, 0x52));
      float cs = cosf(ang), sn = sinf(ang), dt = ax[0] * v[0] + ax[1] * v[1] + ax[2] * v[2];
      float cx = ax[1] * v[2] - ax[2] * v[1], cy = ax[2] * v[0] - ax[0] * v[2], cz = ax[0] * v[1] - ax[1] * v[0];
      d[0] = v[0] * cs + cx * sn + ax[0] * dt * (1 - cs);
      d[1] = v[1] * cs + cy * sn + ax[1] * dt * (1 - cs);
      d[2] = v[2] * cs + cz * sn + ax[2] * dt * (1 - cs);
      break;
    }
    case 1: { /* random filled ball (explosion debris) */
      rand_dir(hj, d);
      float r = cbrtf(u01(pcg(hj + 7)));
      d[0] *= r; d[1] *= r; d[2] *= r;
      jit = 0.f;
      break;
    }
    case 2: { /* ring with a per-shell random tilt */
      float nrm[3], t[3], b[3];
      rand_dir(h3(pid, sd, 0x61), nrm);
      nrm[2] = nrm[2] * 0.6f; /* bias toward rings that read from the ground */
      float l = sqrtf(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]) + 1e-9f;
      nrm[0] /= l; nrm[1] /= l; nrm[2] /= l;
      basis(nrm, t, b);
      float a = 6.2831853f * (j + 0.5f * u01(hj) * 0.2f) / cnt;
      for (int k = 0; k < 3; k++) d[k] = t[k] * cosf(a) + b[k] * sinf(a);
      jit = 0.02f;
      break;
    }
    case 3: { /* palm: few heavy arms over the upper hemisphere */
      float z = 1.f - (j + 0.5f) / (float)cnt * 1.25f, r = sqrtf(fmaxf(0.f, 1.f - z * z));
      float a = j * 2.3999632f + 6.2831853f * u01(h3(pid, sd, 0x71));
      d[0] = r * cosf(a); d[1] = r * sinf(a); d[2] = z;
      jit = 0.04f;
      break;
    }
    case 4: { /* crossette: four-way cross perpendicular to the parent's motion */
      float n[3] = {pv[0], pv[1], pv[2]};
      float l = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (l < 1e-5f) { n[0] = 0; n[1] = 0; n[2] = 1; } else { n[0] /= l; n[1] /= l; n[2] /= l; }
      float t[3], b[3];
      basis(n, t, b);
      float a = 1.5707963f * j + 6.2831853f * u01(h3(pid, sd, 0x81));
      for (int k = 0; k < 3; k++) d[k] = t[k] * cosf(a) + b[k] * sinf(a);
      jit = 0.03f;
      break;
    }
    case 5: { /* heart in a vertical plane facing a random azimuth */
      float t = 6.2831853f * (j + 0.5f) / cnt;
      float st = sinf(t);
      float hx = 16.f * st * st * st / 17.f;
      float hy = (13.f * cosf(t) - 5.f * cosf(2 * t) - 2.f * cosf(3 * t) - cosf(4 * t)) / 17.f;
      float az = 6.2831853f * u01(h3(pid, sd, 0x91));
      d[0] = hx * cosf(az); d[1] = hx * sinf(az); d[2] = hy;
      jit = 0.01f;
      break;
    }
    case 6: { /* cone around the parent's velocity */
      float n[3] = {pv[0], pv[1], pv[2]};
      float l = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (l < 1e-5f) { n[0] = 0; n[1] = 0; n[2] = 1; } else { n[0] /= l; n[1] /= l; n[2] /= l; }
      float t[3], b[3];
      basis(n, t, b);
      float ca = 1.f - u01(hj) * (1.f - cosf(0.45f)), sa = sqrtf(fmaxf(0.f, 1.f - ca * ca));
      float a = 6.2831853f * u01(pcg(hj + 3));
      for (int k = 0; k < 3; k++) d[k] = n[k] * ca + (t[k] * cosf(a) + b[k] * sinf(a)) * sa;
      jit = 0.f;
      break;
    }
    case 7: { /* upper hemisphere (fountains, splashes) */
      rand_dir(hj, d);
      d[2] = fabsf(d[2]);
      jit = 0.f;
      break;
    }
  }
  if (jit > 0.f) {
    float r[3];
    rand_dir(pcg(hj + 99), r);
    d[0] += r[0] * jit; d[1] += r[1] * jit; d[2] += r[2] * jit;
  }
}

API void nv_sys_set_turb_grid(NvSys *s, int mode) { s->tg_mode = mode; }
API int nv_sys_turb_grid_used(NvSys *s) { return s->tg_used; }

/* Bake the curl-noise field on a grid over the particles' bounding box, 6 samples per period of the
 * finest octave (~4% RMS difference from exact evaluation). Worth it only when the grid is much smaller than the particle count: then each
 * particle pays one trilinear lookup instead of 3 noise evaluations per octave. */
static int bake_turbulence(NvSys *s, int n, float tfr, float tt, int toct, uint32_t sd) {
  s->tg_used = 0;
  if (s->tg_mode < 0 || n <= 0) {
    s->tg_on = 0;
    return 0;
  }
  const PB *P = &s->p;
  float lo[3] = {1e30f, 1e30f, 1e30f}, hi[3] = {-1e30f, -1e30f, -1e30f};
  float lx = 1e30f, ly = 1e30f, lz = 1e30f, hx = -1e30f, hy = -1e30f, hz = -1e30f;
#pragma omp parallel for reduction(min : lx, ly, lz) reduction(max : hx, hy, hz) schedule(static)
  for (int i = 0; i < n; i++) {
    lx = fminf(lx, P->x[i]); ly = fminf(ly, P->y[i]); lz = fminf(lz, P->z[i]);
    hx = fmaxf(hx, P->x[i]); hy = fmaxf(hy, P->y[i]); hz = fmaxf(hz, P->z[i]);
  }
  lo[0] = lx; lo[1] = ly; lo[2] = lz; hi[0] = hx; hi[1] = hy; hi[2] = hz;
  float h = 1.f / (fmaxf(tfr, 1e-6f) * (float)(1 << (toct - 1)) * 6.f);
  double G = 1;
  int nn[3];
  for (int a = 0; a < 3; a++) {
    double cells = ceil((hi[a] - lo[a]) / h) + 2;
    if (cells > 4096) {
      s->tg_on = 0;
      return 0;
    }
    nn[a] = (int)cells;
    G *= cells;
  }
  /* hysteresis: switch on below N/4, stay on until N/2, so the field never flickers between modes */
  double limit = s->tg_on ? 0.5 * n : 0.25 * n;
  if (s->tg_mode == 0 && (G > limit || G > 16e6)) {
    s->tg_on = 0;
    return 0;
  }
  s->tg_on = 1;
  size_t need = (size_t)G * 3;
  if (need > s->tg_cap) {
    free(s->tg);
    s->tg = (float *)malloc(need * sizeof(float));
    s->tg_cap = need;
  }
  float *g = s->tg;
#pragma omp parallel for schedule(static)
  for (int k = 0; k < nn[2]; k++)
    for (int j = 0; j < nn[1]; j++)
      for (int i = 0; i < nn[0]; i++) {
        float c[3];
        float X = lo[0] + i * h, Y = lo[1] + j * h, Z = lo[2] + k * h;
        curl_noise(X * tfr, Y * tfr, Z * tfr, tt, toct, sd, c);
        size_t o = 3 * ((size_t)i + (size_t)nn[0] * ((size_t)j + (size_t)nn[1] * k));
        g[o] = c[0]; g[o + 1] = c[1]; g[o + 2] = c[2];
      }
  memcpy(s->tg_n, nn, sizeof nn);
  memcpy(s->tg_o, lo, sizeof lo);
  s->tg_h = h;
  s->tg_used = 1;
  return 1;
}

static inline void turb_lookup(const NvSys *s, float x, float y, float z, float *c) {
  float gx = (x - s->tg_o[0]) / s->tg_h, gy = (y - s->tg_o[1]) / s->tg_h, gz = (z - s->tg_o[2]) / s->tg_h;
  int nx = s->tg_n[0], ny = s->tg_n[1], nz = s->tg_n[2];
  gx = clampf(gx, 0.f, nx - 1.001f); gy = clampf(gy, 0.f, ny - 1.001f); gz = clampf(gz, 0.f, nz - 1.001f);
  int i = (int)gx, j = (int)gy, k = (int)gz;
  float tx = gx - i, ty = gy - j, tz = gz - k;
  size_t sx = 3, sy = 3 * (size_t)nx, sz = 3 * (size_t)nx * ny;
  const float *g = s->tg + 3 * ((size_t)i + (size_t)nx * ((size_t)j + (size_t)ny * k));
  for (int a = 0; a < 3; a++) {
    const float *q = g + a;
    float c00 = lerpf(q[0], q[sx], tx), c10 = lerpf(q[sy], q[sy + sx], tx);
    float c01 = lerpf(q[sz], q[sz + sx], tx), c11 = lerpf(q[sz + sy], q[sz + sy + sx], tx);
    c[a] = lerpf(lerpf(c00, c10, ty), lerpf(c01, c11, ty), tz);
  }
}

API void nv_sys_step(NvSys *s, float dt) {
  PB *P = &s->p;
  int n = P->n;
  scratch_reserve(s, n);
  const float Ta = s->sp[SP_t_ambient];
  const float G[3] = {s->sp[SP_gx], s->sp[SP_gy], s->sp[SP_gz]};
  const float Wd[3] = {s->sp[SP_wx], s->sp[SP_wy], s->sp[SP_wz]};
  const float tamp = s->sp[SP_turb_amp], tfr = s->sp[SP_turb_freq];
  const float tt = (float)s->time * s->sp[SP_turb_speed];
  const int toct = (int)s->sp[SP_turb_octaves] < 1 ? 1 : (int)s->sp[SP_turb_octaves];
  const uint32_t sd = (uint32_t)s->sp[SP_seed] * 2654435761u;
  const uint32_t step = s->stepno;
  NvFluid *fl = s->fluid;
  const int baked = tamp != 0.f && bake_turbulence(s, n, tfr, tt, toct, sd);

#pragma omp parallel for schedule(static)
  for (int i = 0; i < n; i++) {
    const float *K = s->kp[P->kind[i]];
    float x = P->x[i], y = P->y[i], z = P->z[i], vx = P->vx[i], vy = P->vy[i], vz = P->vz[i];
    const uint32_t id = P->id[i];
    float gs = K[KP_gravity];
    float ax = G[0] * gs, ay = G[1] * gs, az = G[2] * gs;
    az += K[KP_buoyancy] * (P->temp[i] - Ta) * 0.001f;
    float airx = Wd[0] * K[KP_wind], airy = Wd[1] * K[KP_wind], airz = Wd[2] * K[KP_wind];
    float tk = tamp * K[KP_turb];
    if (tk != 0.f) {
      float c[3];
      if (baked) turb_lookup(s, x, y, z, c);
      else curl_noise(x * tfr, y * tfr, z * tfr, tt, toct, sd, c);
      ax += c[0] * tk; ay += c[1] * tk; az += c[2] * tk;
    }
    float fk = K[KP_force];
    for (int q = 0; q < s->nfrc && fk != 0.f; q++) {
      const Force *F = &s->frc[q];
      float dxp = x - F->pos[0], dyp = y - F->pos[1], dzp = z - F->pos[2];
      float d2 = dxp * dxp + dyp * dyp + dzp * dzp, d = sqrtf(d2) + 1e-6f;
      float fall = 1.f;
      if (F->radius > 0.f) {
        float q2 = d / F->radius;
        fall = F->falloff > 0.f ? powf(1.f + q2 * q2, -0.5f * F->falloff) : (q2 < 1.f ? 1.f : 0.f);
      }
      float st = F->strength * fall * fk;
      if (F->type == 0) { /* attract (negative = repel) */
        ax -= st * dxp / d; ay -= st * dyp / d; az -= st * dzp / d;
      } else if (F->type == 1) { /* vortex around axis */
        const float *A = F->axis;
        float along = dxp * A[0] + dyp * A[1] + dzp * A[2];
        float rx = dxp - along * A[0], ry = dyp - along * A[1], rz = dzp - along * A[2];
        float rl = sqrtf(rx * rx + ry * ry + rz * rz) + 1e-6f;
        float tx = A[1] * rz - A[2] * ry, ty = A[2] * rx - A[0] * rz, tz = A[0] * ry - A[1] * rx;
        ax += st * tx / rl - 0.25f * st * rx / rl;
        ay += st * ty / rl - 0.25f * st * ry / rl;
        az += st * tz / rl - 0.25f * st * rz / rl;
      } else if (F->type == 2) { /* wind: moves the air, acts through drag */
        airx += st * F->axis[0]; airy += st * F->axis[1]; airz += st * F->axis[2];
      } else if (F->type == 3) { /* local turbulence */
        float c[3], fr = F->freq > 0.f ? F->freq : 1.f;
        curl_noise(x * fr, y * fr, z * fr, (float)s->time * 0.7f, 2, sd + 101u * q, c);
        ax += st * c[0]; ay += st * c[1]; az += st * c[2];
      } else if (F->type == 4) { /* drag field */
        float e = expf(-st * dt);
        vx *= e; vy *= e; vz *= e;
      }
    }
    vx += ax * dt; vy += ay * dt; vz += az * dt;
    float fd = K[KP_fluid_drag];
    if (fl && fd > 0.f) {
      float inv = 1.f / fl->dx;
      float gx = (x - fl->o[0]) * inv, gy = (y - fl->o[1]) * inv, gz = (z - fl->o[2]) * inv;
      if (gx >= 0.f && gy >= 0.f && gz >= 0.f && gx <= fl->nx && gy <= fl->ny && gz <= fl->nz) {
        float uf[3];
        vel_at(fl, fl->u, fl->v, fl->w, gx, gy, gz, uf);
        float c = 1.f - expf(-fd * dt);
        vx += (uf[0] - vx) * c; vy += (uf[1] - vy) * c; vz += (uf[2] - vz) * c;
      }
    }
    float dl = K[KP_drag_lin];
    if (dl > 0.f) {
      float e = expf(-dl * dt);
      vx = airx + (vx - airx) * e; vy = airy + (vy - airy) * e; vz = airz + (vz - airz) * e;
    }
    float dq = K[KP_drag_quad];
    if (dq > 0.f) {
      float rx = vx - airx, ry = vy - airy, rz = vz - airz;
      float sp = sqrtf(rx * rx + ry * ry + rz * rz);
      float fct = 1.f / (1.f + dq * sp * dt); /* implicit quadratic drag: unconditionally stable */
      vx = airx + rx * fct; vy = airy + ry * fct; vz = airz + rz * fct;
    }
    const float x0 = x, y0 = y, z0 = z;
    x += vx * dt; y += vy * dt; z += vz * dt;

    /* collisions */
    int hit = 0, cm = (int)K[KP_collide];
    if (cm > 0 && s->ncol) {
      /* continuous detection: sphere-trace the step against every collider's distance function,
       * so fast particles cannot tunnel through thin geometry between substeps */
      float sx = x - x0, sy = y - y0, sz = z - z0;
      float seg = sqrtf(sx * sx + sy * sy + sz * sz);
      if (seg > 1e-6f) {
        float tbest = 2.f;
        for (int c = 0; c < s->ncol; c++) {
          float p0[3] = {x0, y0, z0};
          float d = collider_dist(s, &s->col[c], p0);
          if (d <= 0.f || d >= seg) continue; /* already inside (handled below), or out of reach */
          float t = d / seg;
          for (int it = 0; it < 32 && t < tbest; it++) {
            float pt[3] = {x0 + sx * t, y0 + sy * t, z0 + sz * t};
            d = collider_dist(s, &s->col[c], pt);
            if (d < 1e-4f) {
              tbest = t;
              break;
            }
            t += d / seg;
            if (t >= 1.f) break;
          }
        }
        if (tbest <= 1.f) {
          /* stop just past the surface; the push-out below places it and reflects the velocity */
          float t = fminf(1.f, tbest + 2e-3f / seg);
          x = x0 + sx * t; y = y0 + sy * t; z = z0 + sz * t;
        }
      }
    }
    if (cm > 0) {
      for (int c = 0; c < s->ncol; c++) {
        float p[3] = {x, y, z}, op[3], nn[3];
        if (!collider_test(s, &s->col[c], p, op, nn)) continue;
        x = op[0] + nn[0] * 1e-4f; y = op[1] + nn[1] * 1e-4f; z = op[2] + nn[2] * 1e-4f;
        const float *cv = s->col[c].vel;
        float rx = vx - cv[0], ry = vy - cv[1], rz = vz - cv[2];
        float vn = rx * nn[0] + ry * nn[1] + rz * nn[2];
        if (vn < -0.5f) hit = 1; /* a real impact, not a particle resting on the surface */
        if (vn < 0.f) {
          float tx = rx - vn * nn[0], ty = ry - vn * nn[1], tz = rz - vn * nn[2];
          float fr = cm == 3 ? 1.f : K[KP_friction], bo = cm == 3 ? 0.f : K[KP_bounce];
          rx = tx * (1.f - fr) - bo * vn * nn[0];
          ry = ty * (1.f - fr) - bo * vn * nn[1];
          rz = tz * (1.f - fr) - bo * vn * nn[2];
          vx = rx + cv[0]; vy = ry + cv[1]; vz = rz + cv[2];
        }
      }
    }
    P->x[i] = x; P->y[i] = y; P->z[i] = z;
    P->vx[i] = vx; P->vy[i] = vy; P->vz[i] = vz;

    /* temperature: Newton + radiative cooling toward ambient */
    float T = P->temp[i];
    T = Ta + (T - Ta) * expf(-K[KP_cool] * dt);
    float crd = K[KP_cool_rad] * 1e-10f;
    if (crd > 0.f && T > Ta) T = Ta + (T - Ta) / cbrtf(1.f + 3.f * crd * (T - Ta) * (T - Ta) * (T - Ta) * dt);
    P->temp[i] = T;
    float age = P->age[i] + dt;
    P->age[i] = age;

    /* events */
    int gen = P->gen[i];
    uint32_t ec = 0;
    uint16_t nt = 0, nd = 0;
    uint8_t ns = 0, nh = 0, dead = 0;
    if (K[KP_trail_kind] >= 0.f && K[KP_trail_rate] > 0.f && gen < MAXGEN) {
      float e = K[KP_trail_rate] * dt;
      int c = (int)e;
      if (u01(h3(id, step, sd ^ 0x1001u)) < e - c) c++;
      nt = (uint16_t)(c > 2000 ? 2000 : c);
    }
    if (hit) {
      if (K[KP_hit_kind] >= 0.f && K[KP_hit_count] > 0.f && gen < MAXGEN) {
        float e = K[KP_hit_count];
        int c = (int)e;
        if (u01(h3(id, step, sd ^ 0x2002u)) < e - c) c++;
        nh = (uint8_t)(c > 255 ? 255 : c);
      }
      if (cm == 2) dead = 1;
    }
    if (!dead && K[KP_split_kind] >= 0.f && K[KP_split_rate] > 0.f && gen < (int)K[KP_split_max_gen] &&
        gen < MAXGEN) {
      float pr = 1.f - expf(-K[KP_split_rate] * dt);
      if (u01(h3(id, step, sd ^ 0x3003u)) < pr) {
        dead = 1;
        int c = (int)K[KP_split_count];
        ns = (uint8_t)(c < 0 ? 0 : (c > 255 ? 255 : c));
      }
    }
    if (!dead && age >= P->life[i]) {
      dead = 1;
      if (K[KP_death_kind] >= 0.f && gen < MAXGEN) {
        int c = (int)K[KP_death_count];
        nd = (uint16_t)(c < 0 ? 0 : (c > 4000 ? 4000 : c));
      }
    }
    s->ev_trail[i] = nt; s->ev_hit[i] = nh; s->ev_split[i] = ns; s->ev_death[i] = nd;
    s->dead[i] = dead;
    ec = (uint32_t)nt + nh + ns + nd;
    s->cnt[i] = ec;
  }

  /* ---- spawn children (deterministic: positions in the queue come from a prefix sum) */
  uint64_t total = scan(s->cnt, s->off, n);
  int alive = 0;
  {
    int a = 0;
#pragma omp parallel for reduction(+ : a) schedule(static)
    for (int i = 0; i < n; i++) a += !s->dead[i];
    alive = a;
  }
  int room = (int)s->sp[SP_max_particles] - alive;
  if (room < 0) room = 0;
  int nq = (int)(total < (uint64_t)room ? total : (uint64_t)room);
  pb_reserve(&s->q, nq);
  uint32_t id0 = s->next_id;
  if (nq > 0) {
#pragma omp parallel for schedule(dynamic, 256)
    for (int i = 0; i < n; i++) {
      if (!s->cnt[i]) continue;
      uint32_t o = s->off[i];
      if (o >= (uint32_t)nq) continue;
      const float *K = s->kp[P->kind[i]];
      const uint32_t pid = P->id[i];
      float pos[3] = {P->x[i], P->y[i], P->z[i]}, pv[3] = {P->vx[i], P->vy[i], P->vz[i]};
      float rgb[3] = {P->cr[i], P->cg[i], P->cb[i]};
      int gen = P->gen[i] + 1;
      float sp = sqrtf(pv[0] * pv[0] + pv[1] * pv[1] + pv[2] * pv[2]);
      (void)sp;
      int nt = s->ev_trail[i], nh = s->ev_hit[i], ns = s->ev_split[i], nd = s->ev_death[i];
      for (int j = 0; j < nt && o < (uint32_t)nq; j++, o++) {
        uint32_t h = h3(pid, step * 4099u + j, sd ^ 0xA1u);
        float t = (j + u01(h)) / (float)nt;
        float cp[3], cv[3], r[3];
        rand_dir(pcg(h + 1), r);
        float jt = K[KP_trail_jitter], inh = K[KP_trail_inherit];
        for (int k = 0; k < 3; k++) {
          cp[k] = pos[k] - pv[k] * dt * (1.f - t);
          cv[k] = pv[k] * inh + r[k] * jt;
        }
        init_particle(s, &s->q, (int)o, (int)K[KP_trail_kind], cp, cv, rgb, gen, id0 + o);
        s->q.age[o] = dt * (1.f - t); /* trail births are spread along the segment */
      }
      for (int j = 0; j < nh && o < (uint32_t)nq; j++, o++) {
        uint32_t h = h3(pid, step * 4099u + j, sd ^ 0xB2u);
        float r[3], cv[3];
        rand_dir(h, r);
        if (r[0] * pv[0] + r[1] * pv[1] + r[2] * pv[2] < 0.f) { r[0] = -r[0]; r[1] = -r[1]; r[2] = -r[2]; }
        float spd = K[KP_hit_speed] * (0.4f + 0.6f * u01(pcg(h + 5)));
        for (int k = 0; k < 3; k++) cv[k] = pv[k] * 0.5f + r[k] * spd;
        init_particle(s, &s->q, (int)o, (int)K[KP_hit_kind], pos, cv, rgb, gen, id0 + o);
      }
      for (int j = 0; j < ns && o < (uint32_t)nq; j++, o++) {
        uint32_t h = h3(pid, step * 4099u + j, sd ^ 0xC3u);
        float r[3], cv[3];
        rand_dir(h, r);
        float spd = K[KP_split_speed] * (0.5f + u01(pcg(h + 5)));
        for (int k = 0; k < 3; k++) cv[k] = pv[k] * K[KP_split_inherit] + r[k] * spd;
        init_particle(s, &s->q, (int)o, (int)K[KP_split_kind], pos, cv, rgb, gen, id0 + o);
      }
      for (int j = 0; j < nd && o < (uint32_t)nq; j++, o++) {
        float d[3], cv[3];
        pattern_dir((int)K[KP_death_pattern], j, nd, pid, sd, pv, d);
        uint32_t h = h3(pid, (uint32_t)j, sd ^ 0xD4u);
        float spd = K[KP_death_speed] * (1.f + K[KP_death_speed_var] * (2.f * u01(h) - 1.f));
        for (int k = 0; k < 3; k++) cv[k] = pv[k] * K[KP_death_inherit] + d[k] * spd;
        init_particle(s, &s->q, (int)o, (int)K[KP_death_kind], pos, cv, rgb, gen, id0 + o);
      }
    }
  }
  s->q.n = nq;
  s->next_id += (uint32_t)nq;

  /* ---- particle -> fluid deposits (smoke trails, heat, fuel) */
  if (fl) {
    int m = 0;
    for (int k = 0; k < s->nk; k++)
      if (s->kp[k][KP_fl_smoke] > 0.f || s->kp[k][KP_fl_heat] > 0.f || s->kp[k][KP_fl_fuel] > 0.f) m = 1;
    if (m) {
      if (s->dep_cap < n) {
        s->dep_cap = n + n / 2;
        s->dep_pos = (float *)realloc(s->dep_pos, sizeof(float) * 3 * s->dep_cap);
        s->dep_amt = (float *)realloc(s->dep_amt, sizeof(float) * 3 * s->dep_cap);
      }
#pragma omp parallel for schedule(static)
      for (int i = 0; i < n; i++) {
        const float *K = s->kp[P->kind[i]];
        s->cnt[i] = K[KP_fl_smoke] > 0.f || K[KP_fl_heat] > 0.f || K[KP_fl_fuel] > 0.f;
      }
      int c = (int)scan(s->cnt, s->off, n);
#pragma omp parallel for schedule(static)
      for (int i = 0; i < n; i++) {
        if (!s->cnt[i]) continue;
        const float *K = s->kp[P->kind[i]];
        size_t o = s->off[i];
        float fade = 1.f - smooth01(P->age[i] / P->life[i]);
        s->dep_pos[3 * o] = P->x[i]; s->dep_pos[3 * o + 1] = P->y[i]; s->dep_pos[3 * o + 2] = P->z[i];
        s->dep_amt[3 * o] = K[KP_fl_smoke] * dt * fade;
        s->dep_amt[3 * o + 1] = K[KP_fl_heat] * dt * fade;
        s->dep_amt[3 * o + 2] = K[KP_fl_fuel] * dt * fade;
      }
      fluid_deposit(fl, c, s->dep_pos, s->dep_amt);
    }
  }

  /* ---- remove the dead and append the children.
   * Nothing died (long-lived systems): append in place, no copy of the survivors at all.
   * Otherwise: stable parallel compaction into the alternate buffer, then swap. */
  PB *Q = &s->q;
  if (alive == n) {
    if (Q->n > 0) {
      pb_reserve(P, n + Q->n);
      pb_append(P, n, Q);
      P->n = n + Q->n;
    }
  } else {
#pragma omp parallel for schedule(static)
    for (int i = 0; i < n; i++) s->cnt[i] = !s->dead[i];
    int nalive = (int)scan(s->cnt, s->off, n);
    PB *A = &s->alt;
    A->n = 0;
    pb_reserve(A, nalive + Q->n);
#pragma omp parallel for schedule(static)
    for (int i = 0; i < n; i++)
      if (!s->dead[i]) pb_copy(A, (int)s->off[i], P, i);
    if (Q->n > 0) pb_append(A, nalive, Q);
    A->n = nalive + Q->n;
    PB tmp = *P;
    *P = *A;
    *A = tmp;
  }
  Q->n = 0;
  s->stepno++;
  s->time += dt;
}

/* One frame: interleaves fluid and particle substeps. */
API void nv_frame(NvSys *s, NvFluid *f, float dt, int psub) {
  ftz();
  double t0 = now_ms();
  if (psub < 1) psub = 1;
  int fsub = 0;
  if (f) {
    if (s && s->fluid != f) nv_sys_set_fluid(s, f);
    if (s) voxelize_pending(s);
    f->maxvel = max_speed(f);
    fsub = (int)ceilf(f->maxvel * dt / (f->fp[FP_cfl] * f->dx));
    fsub = fsub < 1 ? 1 : (fsub > (int)f->fp[FP_max_sub] ? (int)f->fp[FP_max_sub] : fsub);
  }
  int n = psub > fsub ? psub : fsub;
  float h = dt / n;
  int couple = 0;
  for (int k = 0; s && k < s->nk; k++) couple |= s->kp[k][KP_fluid_drag] > 0.f;
  double fms = 0;
  for (int i = 0; i < n; i++) {
    if (f && (i * fsub) / n != ((i + 1) * fsub) / n) {
      /* fluid steps spread evenly among particle substeps */
      double a = now_ms();
      fluid_substep(f, dt / fsub);
      if (f->gpu && s && couple) /* particles riding the flow read the CPU copy of the velocity */
        gpuf_download_velocity(f->gpu, f->u, f->v, f->w);
      fms += now_ms() - a;
    }
    if (s) nv_sys_step(s, h);
  }
  if (f) f->ms = fms;
  if (s) s->ms = now_ms() - t0 - fms;
}

/* stats: [count, particle_ms, fluid_ms, cg_iters, cg_res, maxvel, active_tile_fraction, cells] */
API void nv_stats(NvSys *s, NvFluid *f, float *o) {
  o[6] = f && f->nt ? (float)f->n_prs / f->nt : 0.f;
  o[7] = f ? (float)f->nc : 0.f;
  o[0] = s ? (float)s->p.n : 0.f;
  o[1] = s ? (float)s->ms : 0.f;
  o[2] = f ? (float)f->ms : 0.f;
  o[3] = f ? (float)f->last_iters : 0.f;
  o[4] = f ? f->last_res : 0.f;
  if (f && f->gpu) {
    int it;
    float res;
    double ms;
    gpuf_stats(f->gpu, &it, &res, &ms);
    o[3] = (float)it;
    o[4] = res;
  }
  o[5] = f ? f->maxvel : 0.f;
}

/* ============================================================ render attributes / cache */

static inline void render_attrs(const NvSys *s, int i, float *col, float *rad, float *em, float *an_out) {
  const PB *P = &s->p;
  const float *K = s->kp[P->kind[i]];
  float an = clampf(P->age[i] / P->life[i], 0.f, 1.f);
  *an_out = an;
  float sc = K[KP_size_curve] > 0.f ? powf(an, K[KP_size_curve]) : an;
  *rad = P->size[i] * lerpf(K[KP_size_start], K[KP_size_end], sc);
  uint32_t h = pcg(P->id[i] * 2246822519u + 3u);
  float e = K[KP_emit] * (1.f + K[KP_emit_var] * (2.f * u01(h) - 1.f));
  float fi = K[KP_fade_in], fo = K[KP_fade_out];
  if (fi > 0.f) e *= smooth01(an / fi);
  if (fo > 0.f) e *= 1.f - smooth01((an - (1.f - fo)) / fo);
  if (K[KP_twinkle_amt] > 0.f && K[KP_twinkle_freq] > 0.f) {
    float ph = u01(pcg(h + 17u));
    float fr = K[KP_twinkle_freq] * (0.75f + 0.5f * u01(pcg(h + 29u)));
    float t = P->age[i] * fr + ph;
    float on = (t - floorf(t)) < 0.3f ? 1.f : 0.f;
    e *= 1.f - K[KP_twinkle_amt] * (1.f - on) ;
  }
  int cm = (int)K[KP_color_mode];
  if (cm == 2) {
    float T = P->temp[i];
    bb_color(T, col);
    float r = T / fmaxf(1.f, K[KP_temp0]);
    e *= r * r * r * r; /* Stefan–Boltzmann: radiant exitance ~ T^4 */
  } else if (cm == 1) {
    float t = K[KP_color_curve] > 0.f ? powf(an, K[KP_color_curve]) : an;
    col[0] = lerpf(P->cr[i], K[KP_c1r], t);
    col[1] = lerpf(P->cg[i], K[KP_c1g], t);
    col[2] = lerpf(P->cb[i], K[KP_c1b], t);
  } else {
    col[0] = P->cr[i]; col[1] = P->cg[i]; col[2] = P->cb[i];
  }
  *em = e;
}

/* Cache layout (little endian):
 *   "NVP1" u32 n f32 time u32 0
 *   P f32[3n] | V f16[3n] | Cd f16[3n] | radius f16[n] | emit f16[n] | age f16[n] | id u32[n] | kind u8[n]
 */
API int nv_sys_write(NvSys *s, const char *path) {
  int n = s->p.n;
  size_t sz = 16 + (size_t)n * (12 + 6 + 6 + 2 + 2 + 2 + 4 + 1);
  uint8_t *buf = (uint8_t *)malloc(sz);
  if (!buf) return -1;
  memcpy(buf, "NVP1", 4);
  uint32_t un = (uint32_t)n;
  float tm = (float)s->time;
  uint32_t z = 0;
  memcpy(buf + 4, &un, 4);
  memcpy(buf + 8, &tm, 4);
  memcpy(buf + 12, &z, 4);
  float *Pp = (float *)(buf + 16);
  _Float16 *V = (_Float16 *)(Pp + 3 * (size_t)n);
  _Float16 *C = V + 3 * (size_t)n;
  _Float16 *R = C + 3 * (size_t)n;
  _Float16 *E = R + n;
  _Float16 *A = E + n;
  uint8_t *idb = (uint8_t *)(A + n);
  uint8_t *kb = idb + 4 * (size_t)n;
  const PB *P = &s->p;
#pragma omp parallel for schedule(static)
  for (int i = 0; i < n; i++) {
    Pp[3 * i] = P->x[i]; Pp[3 * i + 1] = P->y[i]; Pp[3 * i + 2] = P->z[i];
    V[3 * i] = (_Float16)P->vx[i]; V[3 * i + 1] = (_Float16)P->vy[i]; V[3 * i + 2] = (_Float16)P->vz[i];
    float col[3], rad, em, an;
    render_attrs(s, i, col, &rad, &em, &an);
    C[3 * i] = (_Float16)col[0]; C[3 * i + 1] = (_Float16)col[1]; C[3 * i + 2] = (_Float16)col[2];
    R[i] = (_Float16)rad;
    E[i] = (_Float16)fminf(em, 60000.f);
    A[i] = (_Float16)an;
    memcpy(idb + 4 * (size_t)i, &P->id[i], 4);
    kb[i] = P->kind[i];
  }
  FILE *fp = fopen(path, "wb");
  if (!fp) {
    free(buf);
    return -2;
  }
  size_t w = fwrite(buf, 1, sz, fp);
  fclose(fp);
  free(buf);
  return w == sz ? n : -3;
}

/* direct export for tests / live use: P (3n), C (3n), R (n), E (n) */
API int nv_sys_export(NvSys *s, float *P3, float *V3, float *C3, float *R, float *E) {
  int n = s->p.n;
  const PB *P = &s->p;
#pragma omp parallel for schedule(static)
  for (int i = 0; i < n; i++) {
    if (P3) { P3[3 * i] = P->x[i]; P3[3 * i + 1] = P->y[i]; P3[3 * i + 2] = P->z[i]; }
    if (V3) { V3[3 * i] = P->vx[i]; V3[3 * i + 1] = P->vy[i]; V3[3 * i + 2] = P->vz[i]; }
    float col[3], rad, em, an;
    render_attrs(s, i, col, &rad, &em, &an);
    if (C3) { C3[3 * i] = col[0]; C3[3 * i + 1] = col[1]; C3[3 * i + 2] = col[2]; }
    if (R) R[i] = rad;
    if (E) E[i] = em;
  }
  return n;
}
