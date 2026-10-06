"""ctypes bridge to libnovacore. Importable without Blender (used by the tests)."""

import ctypes as C
import os
import subprocess

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LIB_PATH = os.path.join(HERE, "lib", "libnovacore.so")
SRC_PATH = os.path.join(HERE, "lib", "nova_core.c")

_f = C.POINTER(C.c_float)
_vp = C.c_void_p

_SIGS = {
    "nv_version": (C.c_int, []),
    "nv_num_threads": (C.c_int, []),
    "nv_set_threads": (None, [C.c_int]),
    "nv_kind_param_names": (C.c_char_p, []),
    "nv_sys_param_names": (C.c_char_p, []),
    "nv_fluid_param_names": (C.c_char_p, []),
    "nv_kind_param_count": (C.c_int, []),
    "nv_sys_param_count": (C.c_int, []),
    "nv_fluid_param_count": (C.c_int, []),
    "nv_kind_param_defaults": (None, [_f]),
    "nv_sys_param_defaults": (None, [_f]),
    "nv_fluid_param_defaults": (None, [_f]),
    "nv_blackbody": (None, [C.c_float, _f]),
    "nv_sys_new": (_vp, []),
    "nv_sys_free": (None, [_vp]),
    "nv_sys_reset": (None, [_vp]),
    "nv_sys_set_params": (None, [_vp, _f]),
    "nv_sys_set_kinds": (None, [_vp, C.c_int, _f]),
    "nv_sys_set_fluid": (None, [_vp, _vp]),
    "nv_sys_set_colliders": (None, [_vp, C.c_int, _f]),
    "nv_sys_set_forces": (None, [_vp, C.c_int, _f]),
    "nv_sys_set_sdf": (C.c_int, [_vp, C.c_int, C.c_int, C.c_int, C.c_int, C.c_float, C.c_float, C.c_float,
                                 C.c_float, _f]),
    "nv_sys_count": (C.c_int, [_vp]),
    "nv_emit": (C.c_int, [_vp, C.c_int, C.c_int, _f, _f, _f]),
    "nv_sys_step": (None, [_vp, C.c_float]),
    "nv_sys_set_turb_grid": (None, [_vp, C.c_int]),
    "nv_sys_turb_grid_used": (C.c_int, [_vp]),
    "nv_sys_write": (C.c_int, [_vp, C.c_char_p]),
    "nv_sys_export": (C.c_int, [_vp, _f, _f, _f, _f, _f]),
    "nv_fluid_new": (_vp, [C.c_int, C.c_int, C.c_int, C.c_float, C.c_float, C.c_float, C.c_float]),
    "nv_fluid_free": (None, [_vp]),
    "nv_fluid_reset": (None, [_vp]),
    "nv_fluid_set_params": (None, [_vp, _f]),
    "nv_fluid_ptr": (_f, [_vp, C.c_int]),
    "nv_fluid_cell_velocity": (None, [_vp, _f]),
    "nv_fluid_cell_velocity_box": (None, [_vp, C.POINTER(C.c_int), _f]),
    "nv_fluid_active_bbox": (C.c_int, [_vp, C.POINTER(C.c_int)]),
    "nv_fluid_max_divergence": (C.c_float, [_vp]),
    "nv_fluid_splat": (None, [_vp, C.c_int, _f, C.c_float, C.c_float, C.c_float, C.c_float, _f, C.c_float, C.c_int]),
    "nv_fluid_step": (None, [_vp, C.c_float]),
    "nv_fluid_set_gpu": (C.c_int, [_vp, C.c_int]),
    "nv_fluid_sync": (None, [_vp, C.c_int]),
    "nv_fluid_timings": (None, [_vp, _f]),
    "nv_frame": (None, [_vp, _vp, C.c_float, C.c_int]),
    "nv_stats": (None, [_vp, _vp, _f]),
}

_lib = None


def build(force=False):
    """Compile the core for this CPU (gcc/clang + OpenMP). Returns (ok, log)."""
    if os.path.exists(LIB_PATH) and not force:
        return True, "already built"
    src_dir = os.path.dirname(SRC_PATH)
    if not os.path.exists(SRC_PATH):
        alt = os.path.join(HERE, "..", "..", "core")
        src_dir = alt if os.path.exists(os.path.join(alt, "nova_core.c")) else src_dir
    sources = [os.path.join(src_dir, "nova_core.c")]
    if all(os.path.exists(os.path.join(src_dir, f)) for f in ("gpu_vk.c", "shaders_spv.h", "nova_params.h")):
        sources.append(os.path.join(src_dir, "gpu_vk.c"))
    log = []
    # with the GPU backend first; without it if this machine has no Vulkan headers
    for srcs in ([*sources], sources[:1]) if len(sources) > 1 else (sources,):
        for cc in ("gcc", "clang", "cc"):
            cmd = [cc, "-O3", "-march=native", "-ffast-math", "-fno-math-errno", "-fopenmp", "-fPIC",
                   "-fvisibility=hidden", "-shared", "-o", LIB_PATH, *srcs, "-lm", "-ldl"]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            except (OSError, subprocess.TimeoutExpired) as e:
                log.append(f"{cc}: {e}")
                continue
            log.append(r.stderr)
            if r.returncode == 0:
                return True, "\n".join(log)
    return False, "\n".join(log)


def lib():
    global _lib
    if _lib is None:
        if not os.path.exists(LIB_PATH):
            ok, log = build()
            if not ok:
                raise RuntimeError("Nova FX core could not be compiled:\n" + log)
        L = C.CDLL(LIB_PATH)
        for name, (res, args) in _SIGS.items():
            fn = getattr(L, name, None)
            if fn is None:
                continue  # optional symbol (e.g. GPU backend not compiled in)
            fn.restype = res
            fn.argtypes = args
        _lib = L
    return _lib


def fptr(a):
    return a.ctypes.data_as(_f) if a is not None else None


def _names(fn):
    return [n for n in fn().decode().split(",") if n]


class Params:
    """Name <-> index table read from the C core, so Python never drifts from it."""

    def __init__(self, names_fn, defaults_fn):
        self.names = _names(names_fn)
        self.index = {n: i for i, n in enumerate(self.names)}
        self.defaults = np.zeros(len(self.names), np.float32)
        defaults_fn(fptr(self.defaults))

    def pack(self, values):
        out = self.defaults.copy()
        for k, v in values.items():
            out[self.index[k]] = v
        return out


_tables = {}


def tables():
    if not _tables:
        L = lib()
        _tables["kind"] = Params(L.nv_kind_param_names, L.nv_kind_param_defaults)
        _tables["sys"] = Params(L.nv_sys_param_names, L.nv_sys_param_defaults)
        _tables["fluid"] = Params(L.nv_fluid_param_names, L.nv_fluid_param_defaults)
    return _tables


def gpu_name():
    L = lib()
    if not hasattr(L, "nv_gpu_name"):
        return "core built without the Vulkan backend"
    L.nv_gpu_init.restype = C.c_int
    L.nv_gpu_name.restype = C.c_char_p
    L.nv_gpu_init()
    return L.nv_gpu_name().decode(errors="replace")


def blackbody(T):
    out = np.zeros(3, np.float32)
    lib().nv_blackbody(float(T), fptr(out))
    return out


class Fluid:
    def __init__(self, res, dx, origin):
        self.res = tuple(int(r) for r in res)
        self.dx = float(dx)
        self.origin = tuple(float(o) for o in origin)
        nx, ny, nz = self.res
        self.h = lib().nv_fluid_new(nx, ny, nz, self.dx, *self.origin)
        if not self.h:
            raise MemoryError("Nova FX: could not allocate the fluid grid")

    def free(self):
        if self.h:
            lib().nv_fluid_free(self.h)
            self.h = None

    __del__ = free

    def set_params(self, values):
        p = tables()["fluid"].pack(values)
        lib().nv_fluid_set_params(self.h, fptr(p))

    def field(self, which):
        """Zero-copy view (nz, ny, nx) of density=0, heat=1, fuel=2, flame=3."""
        nx, ny, nz = self.res
        ptr = lib().nv_fluid_ptr(self.h, which)
        return np.ctypeslib.as_array(ptr, shape=(nz, ny, nx))

    def cell_velocity(self):
        nx, ny, nz = self.res
        out = np.empty((nz, ny, nx, 3), np.float32)
        lib().nv_fluid_cell_velocity(self.h, fptr(out))
        return out

    def active_bbox(self):
        """(i0, i1, j0, j1, k0, k1) cell bounds that can hold smoke/heat/fuel/flame, or None."""
        b = (C.c_int * 6)()
        return tuple(b) if lib().nv_fluid_active_bbox(self.h, b) else None

    def cell_velocity_box(self, box):
        i0, i1, j0, j1, k0, k1 = box
        out = np.empty((k1 - k0, j1 - j0, i1 - i0, 3), np.float32)
        lib().nv_fluid_cell_velocity_box(self.h, (C.c_int * 6)(*box), fptr(out))
        return out

    def splat(self, pos, radius, dens=0.0, heat=0.0, fuel=0.0, vel=None, vel_amt=0.0, mode=1):
        pos = np.ascontiguousarray(pos, np.float32).reshape(-1, 3)
        if len(pos) == 0:
            return
        v = None if vel is None else np.ascontiguousarray(vel, np.float32).reshape(-1, 3)
        lib().nv_fluid_splat(self.h, len(pos), fptr(pos), radius, dens, heat, fuel, fptr(v), vel_amt, mode)

    def step(self, dt):
        lib().nv_fluid_step(self.h, dt)

    def use_gpu(self, on=True):
        """Move the solver to the GPU (Vulkan). Returns True if it is running there."""
        if not hasattr(lib(), "nv_fluid_set_gpu"):
            return False
        return bool(lib().nv_fluid_set_gpu(self.h, 1 if on else 0))

    def sync(self, velocity=False):
        """GPU mode: bring the fields back so field()/cell_velocity() see the current state."""
        if hasattr(lib(), "nv_fluid_sync"):
            lib().nv_fluid_sync(self.h, 1 if velocity else 0)

    def reset(self):
        lib().nv_fluid_reset(self.h)

    def max_divergence(self):
        return lib().nv_fluid_max_divergence(self.h)


class System:
    def __init__(self):
        self.h = lib().nv_sys_new()
        self.fluid = None

    def free(self):
        if self.h:
            lib().nv_sys_free(self.h)
            self.h = None

    __del__ = free

    def reset(self):
        lib().nv_sys_reset(self.h)

    def set_params(self, values):
        lib().nv_sys_set_params(self.h, fptr(tables()["sys"].pack(values)))

    def set_kinds(self, kinds):
        """kinds: list of dicts of kind params (kind references already resolved to indices)."""
        t = tables()["kind"]
        arr = np.stack([t.pack(k) for k in kinds]).astype(np.float32)
        lib().nv_sys_set_kinds(self.h, len(kinds), fptr(np.ascontiguousarray(arr)))

    def set_fluid(self, fluid):
        self.fluid = fluid
        lib().nv_sys_set_fluid(self.h, fluid.h if fluid else None)

    def set_colliders(self, recs):
        a = np.ascontiguousarray(np.asarray(recs, np.float32).reshape(-1, 31)) if len(recs) else np.zeros((1, 31), np.float32)
        lib().nv_sys_set_colliders(self.h, len(recs), fptr(a))

    def set_forces(self, recs):
        a = np.ascontiguousarray(np.asarray(recs, np.float32).reshape(-1, 11)) if len(recs) else np.zeros((1, 11), np.float32)
        lib().nv_sys_set_forces(self.h, len(recs), fptr(a))

    def set_sdf(self, slot, origin, dx, dist):
        """dist: (nz, ny, nx) signed distances in the collider's local space; origin = sample (0,0,0)."""
        d = np.ascontiguousarray(dist, np.float32)
        nz, ny, nx = d.shape
        return lib().nv_sys_set_sdf(self.h, slot, nx, ny, nz, *[float(o) for o in origin], float(dx), fptr(d))

    def emit(self, kind, pos, vel, preage=None):
        pos = np.ascontiguousarray(pos, np.float32).reshape(-1, 3)
        vel = np.ascontiguousarray(vel, np.float32).reshape(-1, 3)
        pa = None if preage is None else np.ascontiguousarray(preage, np.float32)
        return lib().nv_emit(self.h, int(kind), len(pos), fptr(pos), fptr(vel), fptr(pa))

    def frame(self, dt, substeps, fluid=None):
        lib().nv_frame(self.h, fluid.h if fluid else None, dt, int(substeps))

    def count(self):
        return lib().nv_sys_count(self.h)

    def write(self, path):
        return lib().nv_sys_write(self.h, path.encode())

    def export(self):
        n = self.count()
        P = np.empty((n, 3), np.float32)
        V = np.empty((n, 3), np.float32)
        Cc = np.empty((n, 3), np.float32)
        R = np.empty(n, np.float32)
        E = np.empty(n, np.float32)
        lib().nv_sys_export(self.h, fptr(P), fptr(V), fptr(Cc), fptr(R), fptr(E))
        return P, V, Cc, R, E

    def stats(self, fluid=None):
        o = np.zeros(8, np.float32)
        lib().nv_stats(self.h, fluid.h if fluid else None, fptr(o))
        return dict(count=int(o[0]), particle_ms=float(o[1]), fluid_ms=float(o[2]),
                    cg_iters=int(o[3]), cg_res=float(o[4]), max_vel=float(o[5]),
                    active=float(o[6]), cells=int(o[7]))


def read_cache(path):
    """Read a particle cache frame. Returns dict of numpy arrays (float32 where it matters)."""
    raw = np.fromfile(path, dtype=np.uint8)
    if len(raw) < 16 or raw[:4].tobytes() != b"NVP1":
        raise ValueError(f"not a Nova cache: {path}")
    n = int(raw[4:8].view(np.uint32)[0])
    t = float(raw[8:12].view(np.float32)[0])
    o = 16

    def take(dtype, count):
        nonlocal o
        nb = np.dtype(dtype).itemsize * count
        a = raw[o:o + nb].view(dtype)
        o += nb
        return a

    P = take(np.float32, 3 * n)
    V = take(np.float16, 3 * n)
    Cd = take(np.float16, 3 * n)
    R = take(np.float16, n)
    E = take(np.float16, n)
    A = take(np.float16, n)
    ID = take(np.uint32, n)
    K = take(np.uint8, n)
    return dict(n=n, time=t, P=P, V=V, Cd=Cd, radius=R, emit=E, age=A, id=ID, kind=K)
