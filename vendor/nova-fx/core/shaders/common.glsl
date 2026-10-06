// Shared layout for every Nova FX compute kernel: one descriptor set, fields addressed by offset.
layout(std430, binding = 0) buffer BF { float F[]; };    // all float grids (offsets in push constants)
layout(std430, binding = 1) buffer BFU { uint FU[]; };   // same memory as F, viewed as uint (atomics)
layout(std430, binding = 2) buffer BS { uint S[]; };     // stencils (diag | nb<<8), solid flags, buckets
layout(std430, binding = 3) buffer BR { float R[]; };    // reduction partials and results (host visible)
layout(std430, binding = 4) readonly buffer BP { float PTS[]; };  // source points / deposits
layout(std430, binding = 5) readonly buffer BPI { uint PIDX[]; }; // per-tile point ranges

layout(push_constant) uniform PC {
  ivec4 n;   // nx, ny, nz, op
  uvec4 o0;  // offsets
  uvec4 o1;
  uvec4 o2;
  vec4 f0;   // floats
  vec4 f1;
  vec4 f2;
} pc;

uint cidx(int i, int j, int k) { return uint(i + pc.n.x * (j + pc.n.y * k)); }
uint uidx(int i, int j, int k) { return uint(i + (pc.n.x + 1) * (j + pc.n.y * k)); }
uint vidx(int i, int j, int k) { return uint(i + pc.n.x * (j + (pc.n.y + 1) * k)); }
uint widx(int i, int j, int k) { return uint(i + pc.n.x * (j + pc.n.y * k)); }

// clamp-to-edge trilinear sample of a grid stored at F[off] with dims s
float samp_clamp(uint off, ivec3 s, vec3 p) {
  p = clamp(p, vec3(0.0), vec3(s - 1));
  ivec3 b = ivec3(floor(p));
  vec3 t = p - vec3(b);
  float v[8];
  for (int q = 0; q < 8; q++) {
    ivec3 c = clamp(b + ivec3(q & 1, (q >> 1) & 1, (q >> 2) & 1), ivec3(0), s - 1);
    v[q] = F[off + uint(c.x + s.x * (c.y + s.y * c.z))];
  }
  return mix(mix(mix(v[0], v[1], t.x), mix(v[2], v[3], t.x), t.y),
             mix(mix(v[4], v[5], t.x), mix(v[6], v[7], t.x), t.y), t.z);
}

// zero-outside trilinear sample with min/max of the 8 corners
float samp_zero_mm(uint off, ivec3 s, vec3 p, out float lo, out float hi) {
  p = clamp(p, vec3(-1.0), vec3(s));
  ivec3 b = ivec3(floor(p));
  vec3 t = p - vec3(b);
  float v[8];
  for (int q = 0; q < 8; q++) {
    ivec3 c = b + ivec3(q & 1, (q >> 1) & 1, (q >> 2) & 1);
    bool o = any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, s));
    v[q] = o ? 0.0 : F[off + uint(c.x + s.x * (c.y + s.y * c.z))];
  }
  lo = v[0]; hi = v[0];
  for (int q = 1; q < 8; q++) { lo = min(lo, v[q]); hi = max(hi, v[q]); }
  return mix(mix(mix(v[0], v[1], t.x), mix(v[2], v[3], t.x), t.y),
             mix(mix(v[4], v[5], t.x), mix(v[6], v[7], t.x), t.y), t.z);
}

// clamp sample with min/max (velocity MacCormack)
float samp_clamp_mm(uint off, ivec3 s, vec3 p, out float lo, out float hi) {
  p = clamp(p, vec3(0.0), vec3(s - 1));
  ivec3 b = ivec3(floor(p));
  vec3 t = p - vec3(b);
  float v[8];
  for (int q = 0; q < 8; q++) {
    ivec3 c = clamp(b + ivec3(q & 1, (q >> 1) & 1, (q >> 2) & 1), ivec3(0), s - 1);
    v[q] = F[off + uint(c.x + s.x * (c.y + s.y * c.z))];
  }
  lo = v[0]; hi = v[0];
  for (int q = 1; q < 8; q++) { lo = min(lo, v[q]); hi = max(hi, v[q]); }
  return mix(mix(mix(v[0], v[1], t.x), mix(v[2], v[3], t.x), t.y),
             mix(mix(v[4], v[5], t.x), mix(v[6], v[7], t.x), t.y), t.z);
}

vec3 vel_at(uint U, uint V, uint W, vec3 p) {
  ivec3 n = pc.n.xyz;
  return vec3(samp_clamp(U, ivec3(n.x + 1, n.y, n.z), p - vec3(0.0, 0.5, 0.5)),
              samp_clamp(V, ivec3(n.x, n.y + 1, n.z), p - vec3(0.5, 0.0, 0.5)),
              samp_clamp(W, ivec3(n.x, n.y, n.z + 1), p - vec3(0.5, 0.5, 0.0)));
}

vec3 trace(uint U, uint V, uint W, vec3 p, float h) {
  vec3 v1 = vel_at(U, V, W, p);
  vec3 v2 = vel_at(U, V, W, p - 0.5 * h * v1);
  return p - h * v2;
}

bool is_solid(int i, int j, int k, uint solid_off, bool closed_floor) {
  if (i < 0 || j < 0 || i >= pc.n.x || j >= pc.n.y || k >= pc.n.z) return false;
  if (k < 0) return closed_floor;
  return S[solid_off + cidx(i, j, k)] != 0u;
}
