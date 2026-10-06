/*
 * Nova FX — Vulkan compute backend for the fluid solver.
 *
 * The whole fluid state lives on the GPU. Every kernel shares one descriptor set: grids are slices of
 * one float buffer F, addressed by offsets in push constants. The substep sequence mirrors
 * fluid_substep() in nova_core.c (MacCormack, advection-reflection, combustion, vorticity
 * confinement, curl-noise turbulence, MGPCG pressure solve), so CPU and GPU agree to rounding.
 *
 * libvulkan is loaded at runtime (dlopen): the core still loads on machines without Vulkan.
 * Shaders are compiled to SPIR-V at build time and embedded from shaders_spv.h.
 */
#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>

#include "nova_params.h"
#include "shaders_spv.h"

#define API __attribute__((visibility("default")))
#define HIDDEN __attribute__((visibility("hidden")))

#define VK_FUNCS(X)                                                                                \
  X(vkDestroyInstance) X(vkEnumeratePhysicalDevices) X(vkGetPhysicalDeviceProperties)               \
  X(vkGetPhysicalDeviceQueueFamilyProperties) X(vkGetPhysicalDeviceMemoryProperties) X(vkCreateDevice) \
  X(vkDestroyDevice) X(vkGetDeviceQueue) X(vkCreateBuffer) X(vkDestroyBuffer)                         \
  X(vkGetBufferMemoryRequirements) X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory)          \
  X(vkMapMemory) X(vkUnmapMemory) X(vkCreateShaderModule) X(vkDestroyShaderModule)                   \
  X(vkCreateDescriptorSetLayout) X(vkDestroyDescriptorSetLayout) X(vkCreatePipelineLayout)           \
  X(vkDestroyPipelineLayout) X(vkCreateComputePipelines) X(vkDestroyPipeline)                        \
  X(vkCreateDescriptorPool) X(vkDestroyDescriptorPool) X(vkAllocateDescriptorSets)                   \
  X(vkUpdateDescriptorSets) X(vkCreateCommandPool) X(vkDestroyCommandPool)                           \
  X(vkAllocateCommandBuffers) X(vkBeginCommandBuffer) X(vkEndCommandBuffer) X(vkCmdBindPipeline)     \
  X(vkCmdBindDescriptorSets) X(vkCmdPushConstants) X(vkCmdDispatch) X(vkCmdPipelineBarrier)          \
  X(vkCmdCopyBuffer) X(vkCmdFillBuffer) X(vkQueueSubmit) X(vkCreateFence) X(vkDestroyFence)          \
  X(vkWaitForFences) X(vkResetFences) X(vkResetCommandBuffer) X(vkDeviceWaitIdle)                    \
  X(vkFreeDescriptorSets) X(vkCreateQueryPool) X(vkDestroyQueryPool) X(vkCmdWriteTimestamp)            \
  X(vkCmdResetQueryPool) X(vkGetQueryPoolResults)

static PFN_vkGetInstanceProcAddr vk_gipa;
static PFN_vkCreateInstance vk_create_instance;
#define DECL(f) static PFN_##f f##_;
VK_FUNCS(DECL)
#undef DECL

/* pipelines, one per shader */
#define SHADERS(X) X(adv_scalars) X(adv_face) X(combust) X(forces) X(faces) X(project) X(mg) X(cg) X(splat) X(tilemax)
#define SH_ENUM(n) SH_##n,
enum { SHADERS(SH_ENUM) SH_COUNT };

typedef struct {
  VkBuffer buf;
  VkDeviceMemory mem;
  VkDeviceSize size;
  void *map;
} Buf;

typedef struct {
  int32_t n[4];
  uint32_t o0[4], o1[4], o2[4];
  float f0[4], f1[4], f2[4];
} PC; /* 112 bytes, matches common.glsl */

static struct {
  int ready, tried;
  char name[256], err[256];
  void *lib;
  VkInstance inst;
  VkPhysicalDevice phys;
  VkPhysicalDeviceMemoryProperties memp;
  VkDevice dev;
  VkQueue queue;
  uint32_t qfam;
  VkCommandPool pool;
  VkFence fence;
  VkDescriptorSetLayout dsl;
  VkPipelineLayout pl;
  VkPipeline pipe[SH_COUNT];
  VkDescriptorPool dpool;
  float ts_period; /* ns per timestamp tick */
  int ts_ok;
} G;

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec * 1e-6;
}

static int fail(const char *what, VkResult r) {
  snprintf(G.err, sizeof G.err, "%s failed (VkResult %d)", what, (int)r);
  return -1;
}

/* ------------------------------------------------------------------ device setup */

static int mem_type(uint32_t bits, VkMemoryPropertyFlags want) {
  for (uint32_t i = 0; i < G.memp.memoryTypeCount; i++)
    if ((bits & (1u << i)) && (G.memp.memoryTypes[i].propertyFlags & want) == want) return (int)i;
  return -1;
}

static int buf_create(Buf *b, VkDeviceSize size, int host) {
  memset(b, 0, sizeof *b);
  VkBufferCreateInfo bi = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  bi.size = size < 16 ? 16 : size;
  bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
  bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
  VkResult r = vkCreateBuffer_(G.dev, &bi, NULL, &b->buf);
  if (r) return fail("vkCreateBuffer", r);
  VkMemoryRequirements req;
  vkGetBufferMemoryRequirements_(G.dev, b->buf, &req);
  int t = host ? mem_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT |
                                                  VK_MEMORY_PROPERTY_HOST_CACHED_BIT)
               : mem_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
  if (t < 0 && host)
    t = mem_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
  if (t < 0) return fail("memory type", VK_ERROR_FEATURE_NOT_PRESENT);
  VkMemoryAllocateInfo ai = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
  ai.allocationSize = req.size;
  ai.memoryTypeIndex = (uint32_t)t;
  r = vkAllocateMemory_(G.dev, &ai, NULL, &b->mem);
  if (r) {
    vkDestroyBuffer_(G.dev, b->buf, NULL);
    b->buf = VK_NULL_HANDLE;
    return fail("vkAllocateMemory (out of GPU memory?)", r);
  }
  vkBindBufferMemory_(G.dev, b->buf, b->mem, 0);
  b->size = bi.size;
  if (host) vkMapMemory_(G.dev, b->mem, 0, VK_WHOLE_SIZE, 0, &b->map);
  return 0;
}

static void buf_free(Buf *b) {
  if (!b->buf) return;
  if (b->map) vkUnmapMemory_(G.dev, b->mem);
  vkDestroyBuffer_(G.dev, b->buf, NULL);
  vkFreeMemory_(G.dev, b->mem, NULL);
  memset(b, 0, sizeof *b);
}

static VkPipeline make_pipeline(const uint32_t *code, size_t bytes) {
  VkShaderModuleCreateInfo si = {VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
  si.codeSize = bytes;
  si.pCode = code;
  VkShaderModule mod;
  if (vkCreateShaderModule_(G.dev, &si, NULL, &mod)) return VK_NULL_HANDLE;
  VkComputePipelineCreateInfo ci = {VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
  ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
  ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
  ci.stage.module = mod;
  ci.stage.pName = "main";
  ci.layout = G.pl;
  VkPipeline p = VK_NULL_HANDLE;
  vkCreateComputePipelines_(G.dev, VK_NULL_HANDLE, 1, &ci, NULL, &p);
  vkDestroyShaderModule_(G.dev, mod, NULL);
  return p;
}

#define NBIND 6

API int nv_gpu_init(void) {
  if (G.tried) return G.ready ? 0 : -1;
  G.tried = 1;
  G.lib = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_LOCAL);
  if (!G.lib) G.lib = dlopen("libvulkan.so", RTLD_NOW | RTLD_LOCAL);
  if (!G.lib) {
    snprintf(G.err, sizeof G.err, "libvulkan not found");
    return -1;
  }
  vk_gipa = (PFN_vkGetInstanceProcAddr)dlsym(G.lib, "vkGetInstanceProcAddr");
  if (!vk_gipa) return fail("vkGetInstanceProcAddr", VK_ERROR_INITIALIZATION_FAILED);
  vk_create_instance = (PFN_vkCreateInstance)vk_gipa(NULL, "vkCreateInstance");
  VkApplicationInfo app = {VK_STRUCTURE_TYPE_APPLICATION_INFO};
  app.pApplicationName = "Nova FX";
  app.apiVersion = VK_API_VERSION_1_1;
  VkInstanceCreateInfo ii = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
  ii.pApplicationInfo = &app;
  VkResult r = vk_create_instance(&ii, NULL, &G.inst);
  if (r) return fail("vkCreateInstance", r);
#define LOAD(f)                                                        \
  f##_ = (PFN_##f)vk_gipa(G.inst, #f);                                 \
  if (!f##_) {                                                         \
    snprintf(G.err, sizeof G.err, "missing Vulkan function %s", #f);   \
    return -1;                                                         \
  }
  VK_FUNCS(LOAD)
#undef LOAD
  uint32_t n = 0;
  vkEnumeratePhysicalDevices_(G.inst, &n, NULL);
  if (!n) return fail("no Vulkan device", VK_ERROR_INITIALIZATION_FAILED);
  VkPhysicalDevice devs[16];
  if (n > 16) n = 16;
  vkEnumeratePhysicalDevices_(G.inst, &n, devs);
  int best = 0;
  for (uint32_t i = 0; i < n; i++) {
    VkPhysicalDeviceProperties p;
    vkGetPhysicalDeviceProperties_(devs[i], &p);
    if (p.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) { best = (int)i; break; }
  }
  G.phys = devs[best];
  VkPhysicalDeviceProperties props;
  vkGetPhysicalDeviceProperties_(G.phys, &props);
  snprintf(G.name, sizeof G.name, "%s", props.deviceName);
  G.ts_period = props.limits.timestampPeriod;
  vkGetPhysicalDeviceMemoryProperties_(G.phys, &G.memp);
  uint32_t nq = 0;
  vkGetPhysicalDeviceQueueFamilyProperties_(G.phys, &nq, NULL);
  VkQueueFamilyProperties qf[32];
  if (nq > 32) nq = 32;
  vkGetPhysicalDeviceQueueFamilyProperties_(G.phys, &nq, qf);
  G.qfam = UINT32_MAX;
  for (uint32_t i = 0; i < nq; i++)
    if ((qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(qf[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) &&
        qf[i].timestampValidBits) { G.qfam = i; break; }
  for (uint32_t i = 0; i < nq && G.qfam == UINT32_MAX; i++)
    if ((qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(qf[i].queueFlags & VK_QUEUE_GRAPHICS_BIT)) { G.qfam = i; break; }
  for (uint32_t i = 0; i < nq && G.qfam == UINT32_MAX; i++)
    if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) G.qfam = i;
  if (G.qfam == UINT32_MAX) return fail("no compute queue", VK_ERROR_FEATURE_NOT_PRESENT);
  G.ts_ok = qf[G.qfam].timestampValidBits > 0 && G.ts_period > 0.f;
  float prio = 1.f;
  VkDeviceQueueCreateInfo qi = {VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
  qi.queueFamilyIndex = G.qfam;
  qi.queueCount = 1;
  qi.pQueuePriorities = &prio;
  VkDeviceCreateInfo di = {VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
  di.queueCreateInfoCount = 1;
  di.pQueueCreateInfos = &qi;
  r = vkCreateDevice_(G.phys, &di, NULL, &G.dev);
  if (r) return fail("vkCreateDevice", r);
  vkGetDeviceQueue_(G.dev, G.qfam, 0, &G.queue);
  VkCommandPoolCreateInfo pi = {VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
  pi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
  pi.queueFamilyIndex = G.qfam;
  vkCreateCommandPool_(G.dev, &pi, NULL, &G.pool);
  VkFenceCreateInfo fi = {VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  vkCreateFence_(G.dev, &fi, NULL, &G.fence);
  VkDescriptorSetLayoutBinding b[NBIND];
  for (int i = 0; i < NBIND; i++) {
    memset(&b[i], 0, sizeof b[i]);
    b[i].binding = (uint32_t)i;
    b[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    b[i].descriptorCount = 1;
    b[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
  }
  VkDescriptorSetLayoutCreateInfo li = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
  li.bindingCount = NBIND;
  li.pBindings = b;
  vkCreateDescriptorSetLayout_(G.dev, &li, NULL, &G.dsl);
  VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PC)};
  VkPipelineLayoutCreateInfo pli = {VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
  pli.setLayoutCount = 1;
  pli.pSetLayouts = &G.dsl;
  pli.pushConstantRangeCount = 1;
  pli.pPushConstantRanges = &pcr;
  vkCreatePipelineLayout_(G.dev, &pli, NULL, &G.pl);
#define MK(nm)                                                     \
  G.pipe[SH_##nm] = make_pipeline(spv_##nm, sizeof spv_##nm);      \
  if (!G.pipe[SH_##nm]) return fail("pipeline " #nm, VK_ERROR_INITIALIZATION_FAILED);
  SHADERS(MK)
#undef MK
  VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NBIND * 64};
  VkDescriptorPoolCreateInfo dpi = {VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
  dpi.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
  dpi.maxSets = 64;
  dpi.poolSizeCount = 1;
  dpi.pPoolSizes = &ps;
  vkCreateDescriptorPool_(G.dev, &dpi, NULL, &G.dpool);
  G.ready = 1;
  return 0;
}

API const char *nv_gpu_name(void) { return G.ready ? G.name : G.err; }

/* ------------------------------------------------------------------ GPU fluid */

#define MAXLEV 16
#define MAXIT_BATCH 6

typedef struct GpuFluid {
  int nx, ny, nz;
  size_t nc, nu, nv, nw;
  float dx, o[3];
  int ntx, nty, ntz, nt;
  Buf F, S, R, P, PI, stage, RB; /* R: GPU scalars + partials (device local); RB: host readback */
  VkDescriptorSet ds;
  VkCommandBuffer cmd;
  int recording;
  /* float offsets in F */
  uint32_t u, v, w, u0, v0, w0, u1, v1, w1, sc, expn, phi, tmp, fhat, fmn, fmx, cr, cz, cp, cq, cb, r0;
  /* multigrid levels */
  int nlev, lx[MAXLEV], ly[MAXLEV], lz[MAXLEV];
  uint32_t lvx[MAXLEV], lvb[MAXLEV], lvr[MAXLEV], lst[MAXLEV]; /* x, b, r in F; stencil in S */
  uint32_t solid_off, perm_off;
  /* R layout (floats) */
  uint32_t r_part, r_part2, r_npart;
  int last_iters;
  float last_res;
  double ms;
  VkQueryPool qp, qbusy;
  double busy_ms, wait_ms; /* GPU executing vs host round trips, accumulated */
  int nts;              /* timestamps written this substep */
  int ts_phase[64];     /* phase id of each timestamp */
  double phase_ms[8];   /* GPU time per phase, accumulated until read */
} GpuFluid;

enum { PH_ADV_SCALARS, PH_COMBUST, PH_ADV_VEL, PH_FORCES, PH_PROJECT, PH_OTHER, PH_COUNT };

enum { R_ZERO = 0, R_ONE = 1, R_RMAX0 = 2, R_BMAX = 3, R_PQ = 4, R_RZ = 5 /* 5,6 */, R_MAXV = 7, R_RMAXIT = 8 /* +64 */ };

static void begin(GpuFluid *g) {
  if (g->recording) return;
  vkResetCommandBuffer_(g->cmd, 0);
  VkCommandBufferBeginInfo bi = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  vkBeginCommandBuffer_(g->cmd, &bi);
  if (g->qbusy) {
    vkCmdResetQueryPool_(g->cmd, g->qbusy, 0, 2);
    vkCmdWriteTimestamp_(g->cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, g->qbusy, 0);
  }
  vkCmdBindDescriptorSets_(g->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, G.pl, 0, 1, &g->ds, 0, NULL);
  g->recording = 1;
}

static long g_syncs;
API long nv_gpu_sync_count(void) { return g_syncs; }

static void flush(GpuFluid *g) {
  if (!g->recording) return;
  g_syncs++;
  if (g->qbusy) vkCmdWriteTimestamp_(g->cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, g->qbusy, 1);
  vkEndCommandBuffer_(g->cmd);
  double w0 = now_ms();
  VkSubmitInfo si = {VK_STRUCTURE_TYPE_SUBMIT_INFO};
  si.commandBufferCount = 1;
  si.pCommandBuffers = &g->cmd;
  vkQueueSubmit_(G.queue, 1, &si, G.fence);
  vkWaitForFences_(G.dev, 1, &G.fence, VK_TRUE, UINT64_MAX);
  vkResetFences_(G.dev, 1, &G.fence);
  g->recording = 0;
  double busy = 0;
  if (g->qbusy) {
    uint64_t t[2];
    if (vkGetQueryPoolResults_(G.dev, g->qbusy, 0, 2, sizeof t, t, sizeof(uint64_t), VK_QUERY_RESULT_64_BIT) ==
        VK_SUCCESS)
      busy = (double)(t[1] - t[0]) * G.ts_period * 1e-6;
  }
  g->busy_ms += busy;
  g->wait_ms += now_ms() - w0 - busy;
}

/* GPU timestamp marking the START of a phase (the previous phase ends here) */
static void begin(GpuFluid *g);
static void ts(GpuFluid *g, int phase) {
  if (!G.ts_ok || !g->qp || g->nts >= 64) return;
  begin(g);
  vkCmdWriteTimestamp_(g->cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, g->qp, (uint32_t)g->nts);
  g->ts_phase[g->nts++] = phase;
}

static void barrier(GpuFluid *g) {
  VkMemoryBarrier mb = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
  mb.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
  mb.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT |
                     VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_HOST_READ_BIT;
  vkCmdPipelineBarrier_(g->cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT |
                            VK_PIPELINE_STAGE_HOST_BIT,
                        0, 1, &mb, 0, NULL, 0, NULL);
}

static void disp(GpuFluid *g, int sh, const PC *pc, uint32_t gx, uint32_t gy, uint32_t gz) {
  begin(g);
  vkCmdBindPipeline_(g->cmd, VK_PIPELINE_BIND_POINT_COMPUTE, G.pipe[sh]);
  vkCmdPushConstants_(g->cmd, G.pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof *pc, pc);
  vkCmdDispatch_(g->cmd, gx ? gx : 1, gy ? gy : 1, gz ? gz : 1);
  barrier(g);
}

static uint32_t cdiv(int a, int b) { return (uint32_t)((a + b - 1) / b); }

static void pc_init(PC *p, int nx, int ny, int nz, int op) {
  memset(p, 0, sizeof *p);
  p->n[0] = nx; p->n[1] = ny; p->n[2] = nz; p->n[3] = op;
}

static void write_set(GpuFluid *g) {
  Buf *bufs[NBIND] = {&g->F, &g->F, &g->S, &g->R, &g->P, &g->PI};
  VkDescriptorBufferInfo dbi[NBIND];
  VkWriteDescriptorSet wr[NBIND];
  for (int i = 0; i < NBIND; i++) {
    dbi[i].buffer = bufs[i]->buf;
    dbi[i].offset = 0;
    dbi[i].range = VK_WHOLE_SIZE;
    memset(&wr[i], 0, sizeof wr[i]);
    wr[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    wr[i].dstSet = g->ds;
    wr[i].dstBinding = (uint32_t)i;
    wr[i].descriptorCount = 1;
    wr[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    wr[i].pBufferInfo = &dbi[i];
  }
  vkUpdateDescriptorSets_(G.dev, NBIND, wr, 0, NULL);
}

/* copy host bytes into a device buffer through the staging buffer */
static int upload(GpuFluid *g, Buf *dst, VkDeviceSize off, const void *src, size_t bytes) {
  size_t done = 0;
  while (done < bytes) {
    size_t chunk = bytes - done < g->stage.size ? bytes - done : g->stage.size;
    flush(g);
    memcpy(g->stage.map, (const char *)src + done, chunk);
    begin(g);
    VkBufferCopy cp = {0, off + done, chunk};
    vkCmdCopyBuffer_(g->cmd, g->stage.buf, dst->buf, 1, &cp);
    barrier(g);
    flush(g);
    done += chunk;
  }
  return 0;
}

static int download(GpuFluid *g, const Buf *src, VkDeviceSize off, void *dst, size_t bytes) {
  size_t done = 0;
  while (done < bytes) {
    size_t chunk = bytes - done < g->stage.size ? bytes - done : g->stage.size;
    begin(g);
    VkBufferCopy cp = {off + done, 0, chunk};
    vkCmdCopyBuffer_(g->cmd, src->buf, g->stage.buf, 1, &cp);
    barrier(g);
    flush(g);
    memcpy((char *)dst + done, g->stage.map, chunk);
    done += chunk;
  }
  return 0;
}

static void zero(GpuFluid *g, Buf *b) {
  begin(g);
  vkCmdFillBuffer_(g->cmd, b->buf, 0, VK_WHOLE_SIZE, 0);
  barrier(g);
  flush(g);
}

static int ensure_points(GpuFluid *g, size_t pts_bytes, size_t idx_bytes) {
  int changed = 0;
  if (pts_bytes > g->P.size) {
    flush(g);
    buf_free(&g->P);
    if (buf_create(&g->P, pts_bytes + pts_bytes / 2, 0)) return -1;
    if (getenv("NOVA_GPU_ZERO_ALL")) zero(g, &g->P);
    changed = 1;
  }
  if (idx_bytes > g->PI.size) {
    flush(g);
    buf_free(&g->PI);
    if (buf_create(&g->PI, idx_bytes + idx_bytes / 2, 0)) return -1;
    if (getenv("NOVA_GPU_ZERO_ALL")) zero(g, &g->PI);
    changed = 1;
  }
  if (changed) write_set(g);
  return 0;
}

HIDDEN void gpuf_free(GpuFluid *g);

HIDDEN GpuFluid *gpuf_new(int nx, int ny, int nz, float dx, const float *o, int nlev, const int *ldims) {
  if (nv_gpu_init()) return NULL;
  GpuFluid *g = (GpuFluid *)calloc(1, sizeof *g);
  g->nx = nx; g->ny = ny; g->nz = nz; g->dx = dx;
  memcpy(g->o, o, 3 * sizeof(float));
  g->nc = (size_t)nx * ny * nz;
  g->nu = (size_t)(nx + 1) * ny * nz;
  g->nv = (size_t)nx * (ny + 1) * nz;
  g->nw = (size_t)nx * ny * (nz + 1);
  g->ntx = (nx + 7) / 8; g->nty = (ny + 7) / 8; g->ntz = (nz + 7) / 8;
  g->nt = g->ntx * g->nty * g->ntz;
  size_t big = g->nu > g->nv ? g->nu : g->nv;
  if (g->nw > big) big = g->nw;
  /* lay out F */
  size_t off = 0;
#define TAKE(field, count) do { g->field = (uint32_t)off; off += (count); } while (0)
  TAKE(u, g->nu); TAKE(v, g->nv); TAKE(w, g->nw);
  TAKE(u0, g->nu); TAKE(v0, g->nv); TAKE(w0, g->nw);
  TAKE(u1, g->nu); TAKE(v1, g->nv); TAKE(w1, g->nw);
  TAKE(sc, 4 * g->nc); TAKE(expn, g->nc); TAKE(phi, g->nc);
  TAKE(tmp, 12 * g->nc);
  TAKE(fhat, big); TAKE(fmn, big); TAKE(fmx, big);
  TAKE(cr, g->nc); TAKE(cz, g->nc); TAKE(cp, g->nc); TAKE(cq, g->nc); TAKE(cb, g->nc); TAKE(r0, g->nc);
  g->nlev = nlev;
  for (int l = 0; l < nlev; l++) {
    g->lx[l] = ldims[3 * l]; g->ly[l] = ldims[3 * l + 1]; g->lz[l] = ldims[3 * l + 2];
    size_t n = (size_t)g->lx[l] * g->ly[l] * g->lz[l];
    if (l == 0) {
      g->lvx[0] = g->cz; g->lvb[0] = g->cr; g->lvr[0] = g->r0;
    } else {
      TAKE(lvx[l], n); TAKE(lvb[l], n); TAKE(lvr[l], n);
    }
  }
#undef TAKE
  if (off > 0xFFFFFFF0u) {
    snprintf(G.err, sizeof G.err, "grid too large for the GPU backend");
    free(g);
    return NULL;
  }
  size_t soff = 0;
  g->solid_off = (uint32_t)soff; soff += g->nc;
  for (int l = 0; l < nlev; l++) {
    g->lst[l] = (uint32_t)soff;
    soff += (size_t)g->lx[l] * g->ly[l] * g->lz[l];
  }
  g->perm_off = (uint32_t)soff; soff += 512;
  size_t parts = cdiv((int)g->nc, 256) + cdiv(nx + 1, 8) * cdiv(ny + 1, 8) * cdiv(nz + 1, 4) + (size_t)g->nt + 64;
  g->r_npart = (uint32_t)parts;
  g->r_part = 128;
  g->r_part2 = (uint32_t)(128 + parts);
  size_t stage_bytes = 4 * g->nc * sizeof(float);
  if (stage_bytes < (g->nu + g->nv + g->nw) * sizeof(float)) stage_bytes = (g->nu + g->nv + g->nw) * sizeof(float);
  if (stage_bytes > (256u << 20)) stage_bytes = 256u << 20;
  VkCommandBufferAllocateInfo ca = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  ca.commandPool = G.pool;
  ca.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  ca.commandBufferCount = 1;
  size_t pad = getenv("NOVA_GPU_PAD") ? (size_t)atol(getenv("NOVA_GPU_PAD")) : 0; /* debugging */
  if (vkAllocateCommandBuffers_(G.dev, &ca, &g->cmd) || buf_create(&g->F, (off + pad) * sizeof(float), 0) ||
      buf_create(&g->S, (soff + pad) * sizeof(uint32_t), 0) || buf_create(&g->R, (128 + 2 * parts) * sizeof(float), 0) ||
      buf_create(&g->RB, (128 + (size_t)g->nt) * sizeof(float), 1) ||
      buf_create(&g->P, 4096, 0) || buf_create(&g->PI, 4096, 0) || buf_create(&g->stage, stage_bytes, 1)) {
    gpuf_free(g);
    return NULL;
  }
  VkDescriptorSetAllocateInfo dai = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
  dai.descriptorPool = G.dpool;
  dai.descriptorSetCount = 1;
  dai.pSetLayouts = &G.dsl;
  if (vkAllocateDescriptorSets_(G.dev, &dai, &g->ds)) {
    gpuf_free(g);
    return NULL;
  }
  write_set(g);
  begin(g);
  vkCmdFillBuffer_(g->cmd, g->F.buf, 0, VK_WHOLE_SIZE, 0);
  vkCmdFillBuffer_(g->cmd, g->S.buf, 0, VK_WHOLE_SIZE, 0);
  if (pad && getenv("NOVA_GPU_CANARY")) { /* debugging: poison the padding to catch reads past the end */
    vkCmdFillBuffer_(g->cmd, g->F.buf, off * sizeof(float), pad * sizeof(float), 0x7149F2CAu); /* 1e30f */
    vkCmdFillBuffer_(g->cmd, g->S.buf, soff * sizeof(uint32_t), pad * sizeof(uint32_t),
                     (uint32_t)atol(getenv("NOVA_GPU_CANARY")));
  }
  barrier(g);
  flush(g);
  begin(g); /* scalar constants live on the GPU: R[R_ZERO] = 0, R[R_ONE] = 1 */
  vkCmdFillBuffer_(g->cmd, g->R.buf, 0, VK_WHOLE_SIZE, 0);
  vkCmdFillBuffer_(g->cmd, g->R.buf, R_ONE * sizeof(float), sizeof(float), 0x3F800000u);
  barrier(g);
  flush(g);
  if (G.ts_ok) {
    VkQueryPoolCreateInfo qi = {VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
    qi.queryType = VK_QUERY_TYPE_TIMESTAMP;
    qi.queryCount = 64;
    if (vkCreateQueryPool_(G.dev, &qi, NULL, &g->qp)) g->qp = VK_NULL_HANDLE;
    qi.queryCount = 2;
    if (vkCreateQueryPool_(G.dev, &qi, NULL, &g->qbusy)) g->qbusy = VK_NULL_HANDLE;
  }
  return g;
}

HIDDEN void gpuf_free(GpuFluid *g) {
  if (!g) return;
  flush(g);
  vkDeviceWaitIdle_(G.dev);
  Buf *bs[] = {&g->F, &g->S, &g->R, &g->P, &g->PI, &g->stage, &g->RB};
  for (size_t i = 0; i < sizeof bs / sizeof *bs; i++) buf_free(bs[i]);
  if (g->ds) vkFreeDescriptorSets_(G.dev, G.dpool, 1, &g->ds);
  if (g->qp) vkDestroyQueryPool_(G.dev, g->qp, NULL);
  if (g->qbusy) vkDestroyQueryPool_(G.dev, g->qbusy, NULL);
  free(g);
}

HIDDEN void gpuf_reset(GpuFluid *g) {
  begin(g);
  vkCmdFillBuffer_(g->cmd, g->F.buf, 0, VK_WHOLE_SIZE, 0);
  barrier(g);
  flush(g);
}

/* stencils (diag | nb << 8) per level, the solid mask and the noise permutation */
HIDDEN void gpuf_set_stencils(GpuFluid *g, const uint8_t *solid, uint8_t *const *diag, uint8_t *const *nb,
                              const uint8_t *perm) {
  size_t total = g->nc;
  for (int l = 0; l < g->nlev; l++) total += (size_t)g->lx[l] * g->ly[l] * g->lz[l];
  total += 512;
  uint32_t *s = (uint32_t *)malloc(total * sizeof(uint32_t));
  for (size_t c = 0; c < g->nc; c++) s[c] = solid[c];
  for (int l = 0; l < g->nlev; l++) {
    size_t n = (size_t)g->lx[l] * g->ly[l] * g->lz[l];
    uint32_t *d = s + g->lst[l];
#pragma omp parallel for schedule(static)
    for (size_t c = 0; c < n; c++) d[c] = (uint32_t)diag[l][c] | ((uint32_t)nb[l][c] << 8);
  }
  for (int i = 0; i < 512; i++) s[g->perm_off + i] = perm[i];
  upload(g, &g->S, 0, s, total * sizeof(uint32_t));
  free(s);
}

/* reduce partials R[r_part .. + n) into R[dst] (sum or max) */
static void reduce(GpuFluid *g, uint32_t part, uint32_t n, uint32_t dst, int is_max) {
  PC p;
  pc_init(&p, 0, 0, 0, 5);
  p.o1[0] = part; p.o1[1] = n; p.o1[2] = dst; p.o1[3] = (uint32_t)is_max;
  disp(g, SH_cg, &p, 1, 1, 1);
}

/* copy R[first .. first+count) into the host readback buffer and wait; returns its mapping */
static const float *fetch(GpuFluid *g, uint32_t first, uint32_t count) {
  begin(g);
  VkBufferCopy cp = {(VkDeviceSize)first * sizeof(float), 0, (VkDeviceSize)count * sizeof(float)};
  vkCmdCopyBuffer_(g->cmd, g->R.buf, g->RB.buf, 1, &cp);
  barrier(g);
  flush(g);
  return (const float *)g->RB.map;
}

static void vcycle(GpuFluid *g, int l) {
  int nx = g->lx[l], ny = g->ly[l], nz = g->lz[l];
  uint32_t gx = cdiv(nx, 8), gy = cdiv(ny, 8), gz = cdiv(nz, 4);
  PC p;
  pc_init(&p, nx, ny, nz, 1);
  p.o0[0] = g->lvx[l]; p.o0[1] = g->lvb[l]; p.o0[2] = g->lvr[l]; p.o0[3] = g->lst[l];
  if (l == g->nlev - 1) { /* coarsest level: smooth to convergence, symmetric order (as on the CPU) */
    p.n[3] = 0;
    disp(g, SH_mg, &p, gx, gy, gz);
    p.n[3] = 1;
    for (int s = 0; s < 12; s++)
      for (int c = 0; c < 2; c++) { p.o1[0] = (uint32_t)c; disp(g, SH_mg, &p, gx, gy, gz); }
    for (int s = 0; s < 12; s++)
      for (int c = 1; c >= 0; c--) { p.o1[0] = (uint32_t)c; disp(g, SH_mg, &p, gx, gy, gz); }
    return;
  }
  /* pre-smooth from x = 0: the first red sweep needs no neighbours, so no zeroing pass */
  for (int s = 0; s < 2; s++)
    for (int c = 0; c < 2; c++) {
      p.o1[0] = (uint32_t)c;
      p.o1[1] = (s == 0 && c == 0) ? 1u : 0u;
      disp(g, SH_mg, &p, gx, gy, gz);
    }
  p.o1[1] = 0;
  int cx = g->lx[l + 1], cy = g->ly[l + 1], cz = g->lz[l + 1];
  PC q; /* residual fused into the restriction */
  pc_init(&q, cx, cy, cz, 5);
  q.o0[0] = g->lvx[l]; q.o0[1] = g->lst[l]; q.o0[2] = g->lvb[l + 1]; q.o0[3] = g->lst[l + 1];
  q.o1[0] = (uint32_t)nx; q.o1[1] = (uint32_t)ny; q.o1[2] = (uint32_t)nz; q.o1[3] = g->lvb[l];
  disp(g, SH_mg, &q, cdiv(cx, 8), cdiv(cy, 8), cdiv(cz, 4));
  vcycle(g, l + 1);
  PC r;
  pc_init(&r, nx, ny, nz, 4);
  r.o0[0] = g->lvx[l]; r.o0[3] = g->lst[l];
  r.o1[0] = g->lvx[l + 1]; r.o1[1] = (uint32_t)cx; r.o1[2] = (uint32_t)cy;
  disp(g, SH_mg, &r, gx, gy, gz);
  for (int s = 0; s < 2; s++)
    for (int c = 1; c >= 0; c--) { p.o1[0] = (uint32_t)c; disp(g, SH_mg, &p, gx, gy, gz); }
}

/* MGPCG on level 0: solve A phi = cb. CG scalars stay on the GPU; the host syncs once per batch. */
static void solve(GpuFluid *g, const float *fp) {
  uint32_t n = (uint32_t)g->nc, ng = cdiv((int)n, 256);
  PC p;
  pc_init(&p, (int)n, g->nx, g->ny, 4);
  p.o0[0] = g->phi; p.o0[1] = g->cb; p.o0[2] = g->cr; p.o0[3] = g->lst[0];
  p.o2[0] = g->r_part; p.o2[1] = g->r_part2;
  disp(g, SH_cg, &p, ng, 1, 1);
  reduce(g, g->r_part, ng, R_RMAX0, 1);
  reduce(g, g->r_part2, ng, R_BMAX, 1);
  const float *R = fetch(g, 0, 128);
  float bmax = R[R_BMAX], rmax = R[R_RMAX0];
  g->last_iters = 0;
  g->last_res = 0.f;
  if (bmax < 1e-9f) {
    PC z;
    pc_init(&z, g->nx, g->ny, g->nz, 0);
    z.o0[0] = g->phi; z.o0[3] = g->lst[0];
    disp(g, SH_mg, &z, cdiv(g->nx, 8), cdiv(g->ny, 8), cdiv(g->nz, 4));
    return;
  }
  float tol = fp[FP_cg_tol] * bmax;
  if (rmax <= tol) {
    g->last_res = rmax / bmax;
    return;
  }
  int maxit = (int)fp[FP_cg_iter];
  vcycle(g, 0);
  /* rz = r.z ; p = z */
  int cur = 0;
  pc_init(&p, (int)n, 0, 0, 2);
  p.o0[0] = g->cr; p.o0[1] = g->cz; p.o2[0] = g->r_part;
  disp(g, SH_cg, &p, ng, 1, 1);
  reduce(g, g->r_part, ng, R_RZ + cur, 0);
  pc_init(&p, (int)n, 0, 0, 3);
  p.o0[0] = g->cp; p.o0[1] = g->cz; p.o1[1] = R_ZERO; p.o1[2] = R_ONE;
  disp(g, SH_cg, &p, ng, 1, 1);
  int it = 0, done = 0;
  while (!done && it < maxit) {
    int batch = maxit - it < MAXIT_BATCH ? maxit - it : MAXIT_BATCH;
    for (int b = 0; b < batch; b++) {
      pc_init(&p, (int)n, g->nx, g->ny, 0); /* q = A p */
      p.o0[0] = g->cp; p.o0[1] = g->cq; p.o0[3] = g->lst[0]; p.o2[0] = g->r_part;
      disp(g, SH_cg, &p, ng, 1, 1);
      reduce(g, g->r_part, ng, R_PQ, 0);
      pc_init(&p, (int)n, 0, 0, 1); /* x += a p, r -= a q */
      p.o0[0] = g->phi; p.o0[1] = g->cp; p.o0[2] = g->cr; p.o0[3] = g->cq;
      p.o1[1] = R_RZ + cur; p.o1[2] = R_PQ; p.o2[0] = g->r_part;
      disp(g, SH_cg, &p, ng, 1, 1);
      reduce(g, g->r_part, ng, R_RMAXIT + (uint32_t)b, 1);
      vcycle(g, 0);
      pc_init(&p, (int)n, 0, 0, 2); /* rz' = r.z */
      p.o0[0] = g->cr; p.o0[1] = g->cz; p.o2[0] = g->r_part;
      disp(g, SH_cg, &p, ng, 1, 1);
      reduce(g, g->r_part, ng, R_RZ + (1 - cur), 0);
      pc_init(&p, (int)n, 0, 0, 3); /* p = z + (rz'/rz) p */
      p.o0[0] = g->cp; p.o0[1] = g->cz; p.o1[1] = R_RZ + (1 - cur); p.o1[2] = R_RZ + cur;
      disp(g, SH_cg, &p, ng, 1, 1);
      cur = 1 - cur;
    }
    R = fetch(g, 0, 128);
    for (int b = 0; b < batch; b++) {
      it++;
      rmax = R[R_RMAXIT + b];
      if (rmax <= tol) { done = 1; break; }
    }
  }
  g->last_iters = it;
  g->last_res = rmax / bmax;
}

static void project(GpuFluid *g, uint32_t U, uint32_t V, uint32_t W, const float *fp) {
  int nx = g->nx, ny = g->ny, nz = g->nz;
  uint32_t fx = cdiv(nx + 1, 8), fy = cdiv(ny + 1, 8), fz = cdiv(nz + 1, 4);
  uint32_t cf = fp[FP_closed_floor] > 0.5f;
  PC p;
  pc_init(&p, nx, ny, nz, 3); /* zero faces at solids */
  p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o2[0] = g->solid_off; p.o2[1] = cf;
  disp(g, SH_faces, &p, fx, fy, fz);
  pc_init(&p, nx, ny, nz, 0); /* rhs */
  p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o0[3] = g->cb; p.o1[0] = g->expn; p.o2[0] = g->lst[0];
  p.f0[0] = g->dx;
  disp(g, SH_project, &p, cdiv(nx, 8), cdiv(ny, 8), cdiv(nz, 4));
  solve(g, fp);
  pc_init(&p, nx, ny, nz, 1); /* subtract grad phi */
  p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o0[3] = g->phi; p.o2[0] = g->solid_off; p.o2[1] = cf;
  p.f0[0] = 1.f / g->dx;
  disp(g, SH_project, &p, fx, fy, fz);
}

static void advect_velocity(GpuFluid *g, uint32_t su, uint32_t sv, uint32_t sw, uint32_t U, uint32_t V, uint32_t W,
                            uint32_t du, uint32_t dv, uint32_t dw, float dt, int mc) {
  uint32_t src[3] = {su, sv, sw}, dst[3] = {du, dv, dw};
  for (int comp = 0; comp < 3; comp++) {
    int sx = g->nx + (comp == 0), sy = g->ny + (comp == 1), sz = g->nz + (comp == 2);
    PC p;
    pc_init(&p, g->nx, g->ny, g->nz, (mc ? 0 : 2) | (comp << 4));
    p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o0[3] = src[comp];
    p.o1[0] = dst[comp]; p.o1[1] = g->fhat; p.o1[2] = g->fmn; p.o1[3] = g->fmx;
    p.f0[0] = dt / g->dx;
    disp(g, SH_adv_face, &p, cdiv(sx, 8), cdiv(sy, 8), cdiv(sz, 4));
    if (mc) {
      p.n[3] = 1 | (comp << 4);
      disp(g, SH_adv_face, &p, cdiv(sx, 8), cdiv(sy, 8), cdiv(sz, 4));
    }
  }
}

static void add_forces(GpuFluid *g, uint32_t U, uint32_t V, uint32_t W, float dt, const float *fp, double time) {
  int nx = g->nx, ny = g->ny, nz = g->nz;
  uint32_t gx = cdiv(nx, 8), gy = cdiv(ny, 8), gz = cdiv(nz, 4);
  PC p;
  pc_init(&p, nx, ny, nz, 0); /* buoyancy on w faces */
  p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o0[3] = g->sc; p.o1[0] = g->sc + (uint32_t)g->nc;
  p.f0[0] = dt; p.f0[1] = fp[FP_buoy_heat]; p.f0[2] = fp[FP_buoy_smoke];
  disp(g, SH_forces, &p, gx, gy, cdiv(nz + 1, 4));
  float eps = fp[FP_vorticity], tamp = fp[FP_turb_amp];
  if (eps > 0.f || tamp > 0.f) {
    pc_init(&p, nx, ny, nz, 1);
    p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o1[0] = g->tmp;
    p.f0[1] = 0.5f / g->dx;
    disp(g, SH_forces, &p, gx, gy, gz);
    pc_init(&p, nx, ny, nz, 2);
    p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; /* local speed limits the noise push */
    p.o0[3] = g->sc;
    p.o1[0] = g->tmp; p.o1[1] = g->sc + (uint32_t)g->nc; p.o1[2] = g->perm_off;
    p.o1[3] = (uint32_t)fp[FP_seed] * 7919u + 17u;
    p.f0[0] = eps * g->dx; p.f0[1] = 0.5f / g->dx; p.f0[2] = tamp; p.f0[3] = fp[FP_turb_freq];
    p.f1[0] = (float)time * fp[FP_turb_speed]; p.f1[1] = g->dx; p.f1[2] = g->o[0]; p.f1[3] = g->o[1];
    p.f2[0] = g->o[2];
    disp(g, SH_forces, &p, gx, gy, gz);
    pc_init(&p, nx, ny, nz, 3);
    p.o0[0] = U; p.o0[1] = V; p.o0[2] = W; p.o1[0] = g->tmp;
    p.f0[0] = dt;
    disp(g, SH_forces, &p, gx, gy, gz);
  }
  float wd = fp[FP_wind_drag], vd = fp[FP_vel_decay];
  if (wd > 0.f || vd > 0.f) {
    pc_init(&p, nx, ny, nz, 4);
    p.o0[0] = U; p.o0[1] = V; p.o0[2] = W;
    p.f0[0] = 1.f - expf(-wd * dt); p.f0[1] = expf(-vd * dt);
    p.f1[0] = fp[FP_wind_x]; p.f1[1] = fp[FP_wind_y]; p.f1[2] = fp[FP_wind_z];
    disp(g, SH_forces, &p, cdiv(nx + 1, 8), cdiv(ny + 1, 8), cdiv(nz + 1, 4));
  }
}

static void faces_op(GpuFluid *g, int op, uint32_t dU, uint32_t dV, uint32_t dW, uint32_t sU, uint32_t sV,
                     uint32_t sW, float f) {
  PC p;
  pc_init(&p, g->nx, g->ny, g->nz, op);
  p.o0[0] = dU; p.o0[1] = dV; p.o0[2] = dW; p.o1[0] = sU; p.o1[1] = sV; p.o1[2] = sW;
  p.o2[0] = g->lst[0];
  p.f0[0] = f;
  disp(g, SH_faces, &p, cdiv(g->nx + 1, 8), cdiv(g->ny + 1, 8), cdiv(g->nz + 1, 4));
}

HIDDEN void gpuf_substep(GpuFluid *g, const float *fp, float dt, double time) {
  double t0 = now_ms();
  int nx = g->nx, ny = g->ny, nz = g->nz;
  int mc = fp[FP_maccormack] > 0.5f;
  g->nts = 0;
  if (g->qp) {
    begin(g);
    vkCmdResetQueryPool_(g->cmd, g->qp, 0, 64);
  }
  ts(g, PH_ADV_SCALARS);
  /* scalars */
  PC p;
  pc_init(&p, nx, ny, nz, 0);
  p.o0[0] = g->u; p.o0[1] = g->v; p.o0[2] = g->w; p.o0[3] = g->sc; p.o1[0] = g->tmp;
  p.f0[0] = dt / g->dx;
  disp(g, SH_adv_scalars, &p, cdiv(nx, 8), cdiv(ny, 8), cdiv(nz, 4));
  p.n[3] = mc ? 1 : 2;
  disp(g, SH_adv_scalars, &p, cdiv(nx, 8), cdiv(ny, 8), cdiv(nz, 4));
  /* combustion */
  ts(g, PH_COMBUST);
  pc_init(&p, nx, ny, nz, 0);
  p.o0[0] = g->sc; p.o0[1] = g->sc + (uint32_t)g->nc; p.o0[2] = g->sc + 2u * (uint32_t)g->nc;
  p.o0[3] = g->sc + 3u * (uint32_t)g->nc; p.o1[0] = g->expn;
  p.f0[0] = fp[FP_ignite]; p.f0[1] = fp[FP_burn_rate]; p.f0[2] = fp[FP_heat_release]; p.f0[3] = fp[FP_smoke_yield];
  p.f1[0] = fp[FP_expansion]; p.f1[1] = expf(-fp[FP_cool] * dt); p.f1[2] = fp[FP_cool_rad];
  p.f1[3] = expf(-fp[FP_smoke_decay] * dt);
  p.f2[0] = expf(-fp[FP_fuel_decay] * dt); p.f2[1] = expf(-fp[FP_flame_decay] * dt); p.f2[2] = dt;
  disp(g, SH_combust, &p, cdiv((int)g->nc, 256), 1, 1);
  /* velocity */
  if (fp[FP_reflect] > 0.5f) {
    ts(g, PH_ADV_VEL);
    advect_velocity(g, g->u, g->v, g->w, g->u, g->v, g->w, g->u1, g->v1, g->w1, 0.5f * dt, mc);
    ts(g, PH_FORCES);
    add_forces(g, g->u1, g->v1, g->w1, dt, fp, time);
    ts(g, PH_OTHER);
    faces_op(g, 0, g->u0, g->v0, g->w0, g->u1, g->v1, g->w1, 0.f);
    ts(g, PH_PROJECT);
    project(g, g->u1, g->v1, g->w1, fp);
    ts(g, PH_OTHER);
    faces_op(g, 1, g->u0, g->v0, g->w0, g->u1, g->v1, g->w1, 0.f);
    ts(g, PH_ADV_VEL);
    advect_velocity(g, g->u0, g->v0, g->w0, g->u1, g->v1, g->w1, g->u, g->v, g->w, 0.5f * dt, mc);
    ts(g, PH_PROJECT);
    project(g, g->u, g->v, g->w, fp);
  } else {
    ts(g, PH_ADV_VEL);
    advect_velocity(g, g->u, g->v, g->w, g->u, g->v, g->w, g->u1, g->v1, g->w1, dt, mc);
    uint32_t t;
    t = g->u; g->u = g->u1; g->u1 = t;
    t = g->v; g->v = g->v1; g->v1 = t;
    t = g->w; g->w = g->w1; g->w1 = t;
    ts(g, PH_FORCES);
    add_forces(g, g->u, g->v, g->w, dt, fp, time);
    ts(g, PH_PROJECT);
    project(g, g->u, g->v, g->w, fp);
  }
  ts(g, PH_OTHER);
  faces_op(g, 2, g->u, g->v, g->w, 0, 0, 0, 2.f * fp[FP_cfl] * g->dx / dt);
  ts(g, PH_OTHER);
  flush(g);
  if (g->qp && g->nts > 1) {
    uint64_t t[64];
    if (vkGetQueryPoolResults_(G.dev, g->qp, 0, (uint32_t)g->nts, sizeof t, t, sizeof(uint64_t),
                               VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS)
      for (int i = 0; i + 1 < g->nts; i++)
        g->phase_ms[g->ts_phase[i]] += (double)(t[i + 1] - t[i]) * G.ts_period * 1e-6;
  }
  g->ms += now_ms() - t0;
}

/* GPU-side time per phase since the last call: adv scalars, combust, adv velocity, forces, project, other */
API void nv_gpu_phases(void *fluid_gpu, double *out) {
  GpuFluid *g = (GpuFluid *)fluid_gpu;
  for (int i = 0; i < PH_COUNT; i++) { out[i] = g->phase_ms[i]; g->phase_ms[i] = 0; }
  out[PH_COUNT] = g->busy_ms;     /* GPU actually executing */
  out[PH_COUNT + 1] = g->wait_ms; /* host-side latency around each submit (CPU wake-up, submit) */
  g->busy_ms = g->wait_ms = 0;
}

HIDDEN float gpuf_max_speed(GpuFluid *g) {
  PC p;
  pc_init(&p, g->nx, g->ny, g->nz, 4);
  p.o0[0] = g->u; p.o0[1] = g->v; p.o0[2] = g->w; p.o2[2] = g->r_part;
  uint32_t gx = cdiv(g->nx + 1, 8), gy = cdiv(g->ny + 1, 8), gz = cdiv(g->nz + 1, 4);
  disp(g, SH_faces, &p, gx, gy, gz);
  reduce(g, g->r_part, gx * gy * gz, R_MAXV, 1);
  return fetch(g, 0, 128)[R_MAXV];
}

/* Bucket points into the tiles they can reach, upload, run the gather kernel.
 * op 0: emitter splat (stride 6: pos, vel); op 1: deposit (stride 6: pos, smoke, heat, fuel). */
static int bucket_upload(GpuFluid *g, int n, const float *pts6, int op, float R) {
  float inv = 1.f / g->dx;
  int rr = (int)ceilf(R * inv) + 1;
  uint32_t *cnt = (uint32_t *)calloc((size_t)g->nt + 1, sizeof(uint32_t));
  int (*rng)[6] = malloc(sizeof(int[6]) * (size_t)(n ? n : 1));
  size_t total = 0;
  for (int p = 0; p < n; p++) {
    int b[6];
    for (int a = 0; a < 3; a++) {
      int nn = a == 0 ? g->nx : (a == 1 ? g->ny : g->nz), nt = a == 0 ? g->ntx : (a == 1 ? g->nty : g->ntz);
      float gpos = (pts6[6 * p + a] - g->o[a]) * inv;
      int lo, hi;
      if (op == 0) {
        int ci = (int)floorf(gpos);
        lo = ci - rr; hi = ci + rr;
      } else {
        lo = hi = (int)floorf(gpos - 0.5f);
      }
      if (hi < 0 || lo >= nn) { b[0] = 1; b[1] = 0; break; }
      lo = lo < 0 ? 0 : lo; hi = hi >= nn ? nn - 1 : hi;
      b[2 * a] = lo / 8; b[2 * a + 1] = hi / 8;
      if (b[2 * a + 1] >= nt) b[2 * a + 1] = nt - 1;
    }
    memcpy(rng[p], b, sizeof b);
    if (b[1] < b[0]) continue;
    for (int z = b[4]; z <= b[5]; z++)
      for (int y = b[2]; y <= b[3]; y++)
        for (int x = b[0]; x <= b[1]; x++) { cnt[x + g->ntx * (y + g->nty * z)]++; total++; }
  }
  size_t nidx = (size_t)g->nt + 1 + total;
  uint32_t *idx = (uint32_t *)malloc(nidx * sizeof(uint32_t));
  uint32_t acc = 0;
  for (int t = 0; t < g->nt; t++) { idx[t] = acc; acc += cnt[t]; }
  idx[g->nt] = acc;
  memset(cnt, 0, sizeof(uint32_t) * (size_t)g->nt);
  for (int p = 0; p < n; p++) { /* increasing point order inside each tile, like the CPU loop */
    int *b = rng[p];
    if (b[1] < b[0]) continue;
    for (int z = b[4]; z <= b[5]; z++)
      for (int y = b[2]; y <= b[3]; y++)
        for (int x = b[0]; x <= b[1]; x++) {
          int t = x + g->ntx * (y + g->nty * z);
          idx[g->nt + 1 + idx[t] + cnt[t]++] = (uint32_t)p;
        }
  }
  free(cnt);
  free(rng);
  flush(g);
  if (ensure_points(g, (size_t)(n ? n : 1) * 6 * sizeof(float), nidx * sizeof(uint32_t))) {
    free(idx);
    return -1;
  }
  size_t pb = (size_t)n * 6 * sizeof(float), ib = nidx * sizeof(uint32_t);
  if (pb + ib <= g->stage.size) { /* both in one submit */
    flush(g);
    memcpy(g->stage.map, pts6, pb);
    memcpy((char *)g->stage.map + pb, idx, ib);
    begin(g);
    VkBufferCopy c0 = {0, 0, pb}, c1 = {pb, 0, ib};
    if (pb) vkCmdCopyBuffer_(g->cmd, g->stage.buf, g->P.buf, 1, &c0);
    vkCmdCopyBuffer_(g->cmd, g->stage.buf, g->PI.buf, 1, &c1);
    barrier(g); /* the gather dispatch that follows is recorded into the same submit */
  } else {
    if (n) upload(g, &g->P, 0, pts6, pb);
    upload(g, &g->PI, 0, idx, ib);
  }
  free(idx);
  return total ? 1 : 0;
}

HIDDEN void gpuf_splat(GpuFluid *g, int n, const float *pos, float radius, float dens, float heat, float fuel,
                       const float *vel, float vel_amt, int mode) {
  if (n <= 0) return;
  float R = fmaxf(radius, 0.75f * g->dx);
  float *pts = (float *)malloc(sizeof(float) * 6 * (size_t)n);
  for (int p = 0; p < n; p++) {
    for (int a = 0; a < 3; a++) {
      pts[6 * p + a] = pos[3 * p + a];
      pts[6 * p + 3 + a] = vel ? vel[3 * p + a] : 0.f;
    }
  }
  int any = bucket_upload(g, n, pts, 0, R);
  free(pts);
  if (any <= 0) return;
  PC p;
  pc_init(&p, g->nx, g->ny, g->nz, 0);
  p.o0[0] = g->sc; p.o0[1] = g->sc + (uint32_t)g->nc; p.o0[2] = g->sc + 2u * (uint32_t)g->nc;
  p.o1[0] = g->u; p.o1[1] = g->v; p.o1[2] = g->w;
  p.o2[0] = (uint32_t)g->ntx; p.o2[1] = (uint32_t)g->nty; p.o2[3] = g->solid_off;
  p.f0[0] = R * R; p.f0[1] = dens; p.f0[2] = heat; p.f0[3] = fuel;
  p.f1[0] = vel_amt; p.f1[1] = (float)mode; p.f1[2] = g->dx; p.f1[3] = vel && vel_amt > 0.f ? 1.f : 0.f;
  p.f2[0] = g->o[0]; p.f2[1] = g->o[1]; p.f2[2] = g->o[2];
  disp(g, SH_splat, &p, cdiv(g->nx, 8), cdiv(g->ny, 8), cdiv(g->nz, 4));
  flush(g);
}

HIDDEN void gpuf_deposit(GpuFluid *g, int n, const float *pos, const float *amt) {
  if (n <= 0) return;
  float *pts = (float *)malloc(sizeof(float) * 6 * (size_t)n);
  for (int p = 0; p < n; p++)
    for (int a = 0; a < 3; a++) {
      pts[6 * p + a] = pos[3 * p + a];
      pts[6 * p + 3 + a] = amt[3 * p + a];
    }
  int any = bucket_upload(g, n, pts, 1, 0.f);
  free(pts);
  if (any <= 0) return;
  PC p;
  pc_init(&p, g->nx, g->ny, g->nz, 1);
  p.o0[0] = g->sc; p.o0[1] = g->sc + (uint32_t)g->nc; p.o0[2] = g->sc + 2u * (uint32_t)g->nc;
  p.o2[0] = (uint32_t)g->ntx; p.o2[1] = (uint32_t)g->nty;
  p.f1[2] = g->dx;
  p.f2[0] = g->o[0]; p.f2[1] = g->o[1]; p.f2[2] = g->o[2];
  disp(g, SH_splat, &p, cdiv(g->nx, 8), cdiv(g->ny, 8), cdiv(g->nz, 4));
  flush(g);
}

/* which: 0 density 1 heat 2 fuel 3 flame 4 u 5 v 6 w */
HIDDEN void gpuf_download(GpuFluid *g, int which, float *dst) {
  flush(g);
  uint32_t off;
  size_t n;
  if (which < 4) { off = g->sc + (uint32_t)which * (uint32_t)g->nc; n = g->nc; }
  else if (which == 4) { off = g->u; n = g->nu; }
  else if (which == 5) { off = g->v; n = g->nv; }
  else { off = g->w; n = g->nw; }
  download(g, &g->F, (VkDeviceSize)off * sizeof(float), dst, n * sizeof(float));
}

/* all three velocity components in one submit (particles that ride the flow) */
HIDDEN void gpuf_download_velocity(GpuFluid *g, float *u, float *v, float *w) {
  size_t bytes = (g->nu + g->nv + g->nw) * sizeof(float);
  if (bytes > g->stage.size) {
    gpuf_download(g, 4, u);
    gpuf_download(g, 5, v);
    gpuf_download(g, 6, w);
    return;
  }
  begin(g);
  VkBufferCopy cp[3] = {{(VkDeviceSize)g->u * 4, 0, g->nu * 4}, {(VkDeviceSize)g->v * 4, g->nu * 4, g->nv * 4},
                        {(VkDeviceSize)g->w * 4, (g->nu + g->nv) * 4, g->nw * 4}};
  for (int i = 0; i < 3; i++) vkCmdCopyBuffer_(g->cmd, g->F.buf, g->stage.buf, 1, &cp[i]);
  barrier(g);
  flush(g);
  memcpy(u, g->stage.map, g->nu * 4);
  memcpy(v, (char *)g->stage.map + g->nu * 4, g->nv * 4);
  memcpy(w, (char *)g->stage.map + (g->nu + g->nv) * 4, g->nw * 4);
}

/* bounding box of tiles holding anything (cell units, end exclusive); returns 0 if empty */
HIDDEN int gpuf_active_bbox(GpuFluid *g, int *b) {
  PC p;
  pc_init(&p, g->nx, g->ny, g->nz, 0);
  p.o0[0] = g->sc; p.o2[0] = g->r_part;
  disp(g, SH_tilemax, &p, (uint32_t)g->ntx, (uint32_t)g->nty, (uint32_t)g->ntz);
  const float *R = fetch(g, g->r_part, (uint32_t)g->nt);
  int lo[3] = {1 << 30, 1 << 30, 1 << 30}, hi[3] = {-1, -1, -1};
  for (int t = 0; t < g->nt; t++) {
    if (R[t] <= 1e-4f) continue;
    int tc[3] = {t % g->ntx, (t / g->ntx) % g->nty, t / (g->ntx * g->nty)};
    for (int a = 0; a < 3; a++) {
      if (tc[a] < lo[a]) lo[a] = tc[a];
      if (tc[a] > hi[a]) hi[a] = tc[a];
    }
  }
  if (hi[0] < 0) return 0;
  int nn[3] = {g->nx, g->ny, g->nz};
  for (int a = 0; a < 3; a++) {
    b[2 * a] = lo[a] * 8;
    b[2 * a + 1] = (hi[a] + 1) * 8 < nn[a] ? (hi[a] + 1) * 8 : nn[a];
  }
  return 1;
}

HIDDEN void gpuf_stats(GpuFluid *g, int *iters, float *res, double *ms) {
  *iters = g->last_iters;
  *res = g->last_res;
  *ms = g->ms;
  g->ms = 0;
}
