"""Runtime: turns Blender objects into core calls, steps frames, writes and loads caches."""

import concurrent.futures
import math
import os
import re
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

from . import core
from .params import pack_kind
from .props import FLUID_BOOL_SPEC, FLUID_INT_SPEC, FLUID_SPEC

STATE = {"baking": False, "rendering": False}
_RT = {}  # system object name -> Runtime
_VDB_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="nova-vdb")


# ------------------------------------------------------------------ paths

def cache_dir(sysob):
    base = bpy.path.abspath(sysob.nova.cache_dir or "//nova_cache/")
    if base.startswith("//") or not os.path.isabs(base):
        base = os.path.join(bpy.app.tempdir or "/tmp", "nova_cache")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", sysob.name)
    return os.path.join(base, safe)


def particle_path(sysob, frame):
    return os.path.join(cache_dir(sysob), f"p_{frame:05d}.bin")


def volume_path(sysob, frame):
    return os.path.join(cache_dir(sysob), f"v_{frame:05d}.vdb")


def cached_frames(sysob):
    d = cache_dir(sysob)
    if not os.path.isdir(d):
        return []
    return sorted(int(m.group(1)) for m in (re.match(r"p_(\d+)\.bin$", f) for f in os.listdir(d)) if m)


def free_cache(sysob):
    d = cache_dir(sysob)
    if os.path.isdir(d):
        for f in os.listdir(d):
            if re.match(r"[pv]_\d+\.(bin|vdb)$", f):
                os.remove(os.path.join(d, f))
    _RT.pop(sysob.name, None)


# ------------------------------------------------------------------ runtime

class Runtime:
    def __init__(self, sysob):
        self.sys = core.System()
        self.fluid = None
        self.fluid_key = None
        self.gpu_note = ""
        self.last_frame = None
        self.em_state = {}  # emitter name -> dict(prev=Matrix, carry=float, tris=...)
        self.col_prev = {}
        self.stats = {}
        self.vdb_jobs = []

    def free(self):
        self.sys.free()
        if self.fluid:
            self.fluid.free()


def runtime(sysob, create=True):
    rt = _RT.get(sysob.name)
    if rt is None and create:
        rt = _RT[sysob.name] = Runtime(sysob)
    return rt


def stats(sysob):
    rt = _RT.get(sysob.name)
    return rt.stats if rt else {}


def frame_dt(scene, sysob):
    fps = scene.render.fps / scene.render.fps_base
    return sysob.nova.time_scale / fps


def emitters_of(scene, sysob):
    return [ob for ob in scene.objects if ob.nova_emitter.enabled and ob.nova_emitter.system == sysob]


# ------------------------------------------------------------------ configuration

def apply_params(rt, scene, sysob):
    n = sysob.nova
    names = [k.name for k in n.kinds]
    kinds = [pack_kind(k, names) for k in n.kinds] or [{}]
    rt.sys.set_kinds(kinds)
    g, w = n.gravity, n.wind
    rt.sys.set_params(dict(gx=g[0], gy=g[1], gz=g[2], wx=w[0], wy=w[1], wz=w[2], turb_amp=n.turb_amp,
                           turb_freq=n.turb_freq, turb_speed=n.turb_speed, turb_octaves=n.turb_octaves,
                           max_particles=n.max_particles, seed=n.seed, t_ambient=n.t_ambient))
    if rt.fluid:
        fl = n.fluid
        vals = {name: getattr(fl, name) for name, *_ in FLUID_SPEC}
        vals.update({name: getattr(fl, name) for name, *_ in FLUID_INT_SPEC})
        vals.update({name: float(getattr(fl, name)) for name, *_ in FLUID_BOOL_SPEC})
        vals.update(wind_x=fl.wind[0], wind_y=fl.wind[1], wind_z=fl.wind[2], seed=n.seed)
        rt.fluid.set_params(vals)


def domain_box(dom):
    corners = np.array([tuple(dom.matrix_world @ Vector(c)) for c in dom.bound_box])
    return corners.min(0), corners.max(0)


def fluid_layout(sysob):
    fl = sysob.nova.fluid
    lo, hi = domain_box(fl.domain)
    ext = np.maximum(hi - lo, 1e-3)
    dx = float(ext.max() / fl.resolution)
    res = tuple(int(max(4, math.ceil(e / dx))) for e in ext)
    return res, dx, tuple(float(x) for x in lo)


def ensure_fluid(rt, sysob):
    fl = sysob.nova.fluid
    if not (fl.enabled and fl.domain):
        if rt.fluid:
            rt.fluid.free()
            rt.fluid = None
            rt.sys.set_fluid(None)
        return
    res, dx, origin = fluid_layout(sysob)
    key = (res, round(dx, 6), tuple(round(o, 5) for o in origin), fl.device)
    if rt.fluid is None or rt.fluid_key != key:
        if rt.fluid:
            rt.fluid.free()
        rt.fluid = core.Fluid(res, dx, origin)
        rt.fluid_key = key
        rt.gpu_note = ""
        if fl.device == "GPU":
            if rt.fluid.use_gpu(True):
                rt.gpu_note = "GPU: " + core.gpu_name()
            else:
                rt.gpu_note = "GPU unavailable, using CPU: " + core.gpu_name()
        rt.sys.set_fluid(rt.fluid)


def _rows(m):
    return [m[0][0], m[0][1], m[0][2], m[0][3], m[1][0], m[1][1], m[1][2], m[1][3],
            m[2][0], m[2][1], m[2][2], m[2][3]]


def bake_sdf(ob, depsgraph, res):
    """Signed distance field of a mesh in its local space: (origin, dx, dist[nz, ny, nx]).
    Distance from Blender's BVH nearest-point query, sign from the surface normal there."""
    from mathutils.bvhtree import BVHTree
    ev = ob.evaluated_get(depsgraph)
    bvh = BVHTree.FromObject(ev, depsgraph)
    bb = np.array([tuple(v) for v in ev.bound_box])
    lo, hi = bb.min(0), bb.max(0)
    dx = float(max((hi - lo).max(), 1e-4) / res)
    lo = lo - 3 * dx
    n = np.ceil((hi + 3 * dx - lo) / dx).astype(int) + 1
    nx, ny, nz = (int(v) for v in n)
    out = np.empty((nz, ny, nx), np.float32)
    far = float(np.linalg.norm(n) * dx)
    find = bvh.find_nearest
    for k in range(nz):
        z = lo[2] + k * dx
        for j in range(ny):
            y = lo[1] + j * dx
            row = out[k, j]
            for i in range(nx):
                p = Vector((lo[0] + i * dx, y, z))
                loc, nrm, _idx, dist = find(p)
                if loc is None:
                    row[i] = far
                else:
                    row[i] = dist if (p - loc).dot(nrm) >= 0 else -dist
    return tuple(float(v) for v in lo), dx, out


def ensure_sdf(rt, ob, depsgraph, frame):
    """Upload the collider's distance field once (or every frame if deforming); returns its slot."""
    c = ob.nova_collider
    slots = rt.__dict__.setdefault("sdf_slots", {})
    keys = rt.__dict__.setdefault("sdf_keys", {})
    slot = slots.setdefault(ob.name, len(slots))
    me = ob.data if ob.type == "MESH" else None
    key = (ob.data.name if ob.data else ob.name, len(me.vertices) if me else 0, c.sdf_res,
           frame if c.deforming else None, round(sum(ob.bound_box[0]) + sum(ob.bound_box[6]), 6))
    if keys.get(ob.name) != key:
        origin, dx, dist = bake_sdf(ob, depsgraph, c.sdf_res)
        rt.sys.set_sdf(slot, origin, dx, dist)
        keys[ob.name] = key
    return slot


def collider_records(rt, scene, dt, depsgraph=None, frame=0):
    recs = []
    shapes = {"PLANE": 0, "SPHERE": 1, "BOX": 2, "MESH": 3}
    for ob in scene.objects:
        c = ob.nova_collider
        if not c.enabled or ob.hide_get() and ob.hide_render:
            continue
        bb = np.array([tuple(v) for v in ob.bound_box]) if ob.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} \
            else np.array([[-1, -1, -1], [1, 1, 1]], float)
        lo, hi = bb.min(0), bb.max(0)
        center = (lo + hi) / 2
        half = np.maximum((hi - lo) / 2, 1e-4)
        mw = ob.matrix_world.copy()
        if c.shape == "MESH" and ob.type == "MESH" and depsgraph is not None:
            slot = ensure_sdf(rt, ob, depsgraph, frame)
            local = mw
            ext = (float(slot), 0, 0)
        elif c.shape == "MESH":
            continue
        elif c.shape == "PLANE":
            local = mw @ Matrix.Translation((0, 0, center[2]))
            ext = (0, 0, 0)
        elif c.shape == "SPHERE":
            local = mw @ Matrix.Translation(tuple(center))
            ext = (float(half.max()), 0, 0)
        else:
            local = mw @ Matrix.Translation(tuple(center))
            ext = tuple(float(h) for h in half)
        prev = rt.col_prev.get(ob.name, local)
        vel = (local.to_translation() - prev.to_translation()) / dt if dt > 0 else (0, 0, 0)
        rt.col_prev[ob.name] = local.copy()
        recs.append([shapes[c.shape], *_rows(local.inverted_safe()), *_rows(local), *ext, *vel])
    return recs


def force_records(scene):
    types = {"ATTRACT": 0, "VORTEX": 1, "WIND": 2, "TURBULENCE": 3, "DRAG": 4}
    recs = []
    for ob in scene.objects:
        f = ob.nova_force
        if not f.enabled:
            continue
        mw = ob.matrix_world
        axis = (mw.to_3x3() @ Vector((0, 0, 1))).normalized()
        recs.append([types[f.type], *mw.to_translation(), *axis, f.strength, f.radius, f.freq, f.falloff])
    return recs


# ------------------------------------------------------------------ emitter sampling

def _mesh_tris(ob, depsgraph):
    ev = ob.evaluated_get(depsgraph)
    me = ev.to_mesh()
    try:
        me.calc_loop_triangles()
        nv, nt = len(me.vertices), len(me.loop_triangles)
        co = np.empty(nv * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        if nt == 0:
            return co, None
        tri = np.empty(nt * 3, np.int32)
        me.loop_triangles.foreach_get("vertices", tri)
        return co, tri.reshape(-1, 3)
    finally:
        ev.to_mesh_clear()


def _cone(dirs, spread, rng):
    """Random directions inside a cone of half-angle `spread` around each unit vector."""
    n = len(dirs)
    if spread <= 1e-6:
        return dirs
    cos_max = math.cos(min(spread, math.pi))
    z = 1 - rng.random(n) * (1 - cos_max)
    r = np.sqrt(np.maximum(0, 1 - z * z))
    a = rng.random(n) * 2 * np.pi
    # orthonormal basis per direction (Frisvad / Duff et al.)
    s = np.where(dirs[:, 2] >= 0, 1.0, -1.0)
    aa = -1.0 / (s + dirs[:, 2])
    b = dirs[:, 0] * dirs[:, 1] * aa
    t1 = np.stack([1 + s * dirs[:, 0] ** 2 * aa, s * b, -s * dirs[:, 0]], 1)
    t2 = np.stack([b, s + dirs[:, 1] ** 2 * aa, -dirs[:, 1]], 1)
    return (t1 * (r * np.cos(a))[:, None] + t2 * (r * np.sin(a))[:, None] + dirs * z[:, None]).astype(np.float32)


def _random_dirs(n, rng):
    z = rng.random(n) * 2 - 1
    a = rng.random(n) * 2 * np.pi
    r = np.sqrt(1 - z * z)
    return np.stack([r * np.cos(a), r * np.sin(a), z], 1).astype(np.float32)


def sample_local(em, st, ob, depsgraph, n, rng):
    """n local-space points + local outward directions for the emitter's shape."""
    if em.shape in {"SURFACE", "VERTS"} and ob.type == "MESH":
        if em.deforming or "co" not in st:
            co, tri = _mesh_tris(ob, depsgraph)
            st["co"], st["tri"] = co, tri
            if tri is not None:
                a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
                cr = np.cross(b - a, c - a)
                area = np.linalg.norm(cr, axis=1)
                st["tri_n"] = cr / np.maximum(area, 1e-12)[:, None]
                cdf = np.cumsum(area)
                st["cdf"] = cdf / cdf[-1] if cdf[-1] > 0 else None
                st["area"] = float(cdf[-1])
        co, tri = st["co"], st["tri"]
        if em.shape == "VERTS" or tri is None or st.get("cdf") is None:
            idx = rng.integers(0, len(co), n)
            p = co[idx]
            d = p / np.maximum(np.linalg.norm(p, axis=1), 1e-9)[:, None]
            return p.astype(np.float32), d.astype(np.float32)
        t = np.searchsorted(st["cdf"], rng.random(n))
        t = np.minimum(t, len(tri) - 1)
        u, v = rng.random(n), rng.random(n)
        flip = u + v > 1
        u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
        a, b, c = co[tri[t, 0]], co[tri[t, 1]], co[tri[t, 2]]
        p = a + (b - a) * u[:, None] + (c - a) * v[:, None]
        return p.astype(np.float32), st["tri_n"][t].astype(np.float32)
    if em.shape == "SPHERE":
        d = _random_dirs(n, rng)
        r = em.radius * np.cbrt(rng.random(n))
        return (d * r[:, None]).astype(np.float32), d
    return np.zeros((n, 3), np.float32), _random_dirs(n, rng)


def _xform(m, p):
    M = np.array(m, np.float32)
    return p @ M[:3, :3].T + M[:3, 3]


def _xform_dir(m, d):
    M = np.array(m.to_3x3().inverted_safe().transposed(), np.float32)
    out = d @ M.T
    return out / np.maximum(np.linalg.norm(out, axis=1), 1e-9)[:, None]


def emit_frame(rt, scene, sysob, frame, dt, depsgraph):
    """Particles born during (frame-1, frame]; positions interpolate the emitter motion (sub-frame)."""
    names = [k.name for k in sysob.nova.kinds]
    for ei, ob in enumerate(emitters_of(scene, sysob)):
        em = ob.nova_emitter
        st = rt.em_state.setdefault(ob.name, {"carry": 0.0})
        cur = ob.matrix_world.copy()
        prev = st.get("prev", cur)
        st["prev"] = cur
        kind = names.index(em.kind) if em.kind in names else -1
        active = em.frame_start <= frame <= em.frame_end
        n_rate = 0
        rng = np.random.default_rng([sysob.nova.seed, em.seed, ei, frame & 0x7FFFFFFF])
        if active and em.rate > 0:
            if em.random_timing:
                n_rate = int(rng.poisson(em.rate * dt))
            else:
                exact = em.rate * dt + st["carry"]
                n_rate = int(exact)
                st["carry"] = exact - n_rate
        n = n_rate + (em.burst if frame == em.burst_frame else 0)
        if kind >= 0 and n > 0:
            n = min(n, 5_000_000)
            p, d = sample_local(em, st, ob, depsgraph, n, rng)
            t = rng.random(n).astype(np.float32)
            if frame == em.burst_frame and em.burst:
                t[n_rate:] = 1.0  # bursts happen exactly on the frame
            pw0, pw1 = _xform(prev, p), _xform(cur, p)
            pos = pw0 + (pw1 - pw0) * t[:, None]
            if em.direction == "OBJECT_Z":
                z = np.array(cur.to_3x3() @ Vector((0, 0, 1)), np.float32)
                z /= max(np.linalg.norm(z), 1e-9)
                dirs = np.tile(z, (n, 1))
            elif em.direction == "RANDOM":
                dirs = _random_dirs(n, rng)
            else:
                dirs = _xform_dir(cur, d)
            dirs = _cone(dirs, em.spread, rng) if em.direction != "RANDOM" else dirs
            spd = em.speed * (1 + em.speed_var * (rng.random(n) * 2 - 1))
            vel = dirs * spd[:, None].astype(np.float32)
            if em.inherit != 0 and dt > 0:
                vel += (pw1 - pw0) / dt * em.inherit
            preage = ((1 - t) * dt).astype(np.float32)
            rt.sys.emit(kind, pos, vel, preage)
        if rt.fluid and em.fl_enabled and active:
            fluid_source(rt, ob, em, st, depsgraph, cur, rng, frame)


def fluid_source(rt, ob, em, st, depsgraph, mw, rng, frame):
    f = rt.fluid
    dx = f.dx
    R = em.fl_radius if em.fl_radius > 0 else 1.5 * dx
    if em.shape in {"SURFACE", "VERTS"} and ob.type == "MESH":
        if "area" not in st:
            sample_local(em, st, ob, depsgraph, 1, rng)
        scale = max(mw.to_scale())
        area = st.get("area", 1.0) * scale * scale
        n = em.fl_points or int(min(60000, max(64, 2.0 * area / (R * R))))
    elif em.shape == "SPHERE":
        vol = 4.18879 * (em.radius * max(mw.to_scale())) ** 3
        n = em.fl_points or int(min(60000, max(8, 3.0 * vol / (R ** 3))))
    else:
        n = em.fl_points or 1
    p, d = sample_local(em, st, ob, depsgraph, n, rng)
    pos = _xform(mw, p)
    # flickering source: modulate by noise so the flame front licks instead of glowing evenly
    amt = np.ones(n, np.float32)
    if em.fl_noise > 0 and n > 1:
        amt = 1 - em.fl_noise * rng.random(n).astype(np.float32) ** 2
    vel = None
    if em.fl_speed != 0:
        if em.direction == "OBJECT_Z":
            z = np.array(mw.to_3x3() @ Vector((0, 0, 1)), np.float32)
            dirs = np.tile(z / max(np.linalg.norm(z), 1e-9), (n, 1))
        else:
            dirs = _xform_dir(mw, d)
        vel = dirs * em.fl_speed
    # group by noise level in a few buckets to keep one splat call per bucket
    for lo, hi in ((0.0, 0.5), (0.5, 0.8), (0.8, 1.01)):
        m = (amt >= lo) & (amt < hi)
        if not m.any():
            continue
        k = float(amt[m].mean())
        f.splat(pos[m], R, dens=em.fl_density * k, heat=em.fl_heat * k, fuel=em.fl_fuel * k,
                vel=None if vel is None else vel[m], vel_amt=0.8 if vel is not None else 0.0, mode=1)


# ------------------------------------------------------------------ stepping

def reset(rt, scene, sysob):
    rt.sys.reset()
    ensure_fluid(rt, sysob)
    if rt.fluid:
        rt.fluid.reset()
    rt.em_state.clear()
    rt.col_prev.clear()
    rt.last_frame = None


def step(scene, sysob, frame, depsgraph=None, write=True):
    """Advance the system to `frame` (must be start or last+1). Returns the runtime."""
    n = sysob.nova
    rt = runtime(sysob)
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    dt = frame_dt(scene, sysob)
    t0 = time.perf_counter()
    if frame <= n.frame_start or rt.last_frame is None or frame != rt.last_frame + 1:
        reset(rt, scene, sysob)
        apply_params(rt, scene, sysob)
        rt.sys.set_colliders(collider_records(rt, scene, dt, depsgraph, frame))
        rt.sys.set_forces(force_records(scene))
        emit_frame(rt, scene, sysob, frame, dt, depsgraph)
    else:
        ensure_fluid(rt, sysob)
        apply_params(rt, scene, sysob)
        rt.sys.set_colliders(collider_records(rt, scene, dt, depsgraph, frame))
        rt.sys.set_forces(force_records(scene))
        # sources first (they feed this frame's fluid step), then move, then the new births
        rt.sys.frame(dt, n.substeps, rt.fluid)
        emit_frame(rt, scene, sysob, frame, dt, depsgraph)
    rt.last_frame = frame
    sim_ms = (time.perf_counter() - t0) * 1000
    if write:
        os.makedirs(cache_dir(sysob), exist_ok=True)
        rt.sys.write(particle_path(sysob, frame))
        if rt.fluid:
            write_vdb(rt, sysob, frame)
    st = rt.sys.stats(rt.fluid)
    st["frame_ms"] = sim_ms
    st["device"] = rt.gpu_note
    st["frame"] = frame
    rt.stats = st
    return rt


# ------------------------------------------------------------------ VDB output

def _vdb_write(path, grids_np, dx, origin, vel, ijk):
    import openvdb as vdb
    tr = vdb.createLinearTransform([[dx, 0, 0, 0], [0, dx, 0, 0], [0, 0, dx, 0],
                                    [origin[0] + 0.5 * dx, origin[1] + 0.5 * dx, origin[2] + 0.5 * dx, 1]])
    grids = []
    for name, arr in grids_np.items():
        g = vdb.FloatGrid()
        if arr is not None:
            g.copyFromArray(np.ascontiguousarray(arr.transpose(2, 1, 0)), ijk=ijk, tolerance=1e-4)
        g.name = name
        g.transform = tr
        grids.append(g)
    if vel is not None:
        g = vdb.Vec3SGrid()
        g.copyFromArray(np.ascontiguousarray(vel.transpose(2, 1, 0, 3)), ijk=ijk, tolerance=1e-3)
        g.name = "velocity"
        g.transform = tr
        grids.append(g)
    tmp = path + ".tmp"
    vdb.write(tmp, grids=grids)
    os.replace(tmp, path)


def write_vdb(rt, sysob, frame):
    """Only the active box is copied and written: cost follows the effect, not the domain."""
    f = rt.fluid
    f.sync(velocity=sysob.nova.fluid.write_velocity)
    box = f.active_bbox()
    if box is None:
        data, vel, ijk = {"density": None, "heat": None, "flame": None}, None, (0, 0, 0)
    else:
        i0, i1, j0, j1, k0, k1 = box
        sl = (slice(k0, k1), slice(j0, j1), slice(i0, i1))
        data = {"density": f.field(0)[sl].copy(), "heat": f.field(1)[sl].copy(), "flame": f.field(3)[sl].copy()}
        vel = f.cell_velocity_box(box) if sysob.nova.fluid.write_velocity else None
        ijk = (i0, j0, k0)
    rt.vdb_jobs = [j for j in rt.vdb_jobs if not j.done()]
    rt.vdb_jobs.append(_VDB_POOL.submit(_vdb_write, volume_path(sysob, frame), data, f.dx, f.origin, vel, ijk))


def wait_vdb(sysob):
    rt = _RT.get(sysob.name)
    if rt:
        for j in rt.vdb_jobs:
            j.result()
        rt.vdb_jobs = []


# ------------------------------------------------------------------ loading into Blender

def _set_attr(pc, name, dtype, domain_values, kind):
    attrs = pc.attributes
    a = attrs.get(name)
    if a is None or a.data_type != dtype:
        if a is not None:
            attrs.remove(a)
        a = attrs.new(name, dtype, "POINT")
    a.data.foreach_set(kind, domain_values)


def load_into(sysob, data):
    pc = sysob.data
    n = int(data["n"])
    sel = None
    if not STATE["rendering"] and sysob.nova.viewport_pct < 100 and n:
        sel = (data["id"] * np.uint32(2654435761) >> np.uint32(16)) % 100 < sysob.nova.viewport_pct
        n = int(sel.sum())

    def pick(a, w=1):
        a = a.reshape(-1, w) if w > 1 else a
        return a[sel] if sel is not None else a

    if len(pc.points) != n:
        pc.resize(n)
    if n == 0:
        pc.update_tag()
        return
    P = pick(data["P"], 3).astype(np.float32, copy=False).ravel()
    pc.attributes["position"].data.foreach_set("vector", P)
    R = pick(data["radius"]).astype(np.float32) * sysob.nova.size_mult
    _set_attr(pc, "radius", "FLOAT", R, "value")
    _set_attr(pc, "Cd", "FLOAT_VECTOR", pick(data["Cd"], 3).astype(np.float32).ravel(), "vector")
    _set_attr(pc, "emit", "FLOAT", pick(data["emit"]).astype(np.float32), "value")
    _set_attr(pc, "velocity", "FLOAT_VECTOR", pick(data["V"], 3).astype(np.float32).ravel(), "vector")
    _set_attr(pc, "age", "FLOAT", pick(data["age"]).astype(np.float32), "value")
    _set_attr(pc, "id", "INT", pick(data["id"]).view(np.int32), "value")
    _set_attr(pc, "kind", "INT", pick(data["kind"]).astype(np.int32), "value")
    pc.update_tag()


def load_frame(sysob, frame):
    path = particle_path(sysob, frame)
    if os.path.exists(path):
        try:
            load_into(sysob, core.read_cache(path))
            return True
        except (ValueError, OSError):
            pass
    load_into(sysob, {"n": 0})
    return False


def reload_frame(sysob, scene):
    if sysob and sysob.nova.is_system:
        load_frame(sysob, scene.frame_current)


def systems(scene):
    return [ob for ob in scene.objects if ob.nova.is_system and ob.type == "POINTCLOUD"]


def ensure_volume_object(scene, sysob):
    from . import render
    fl = sysob.nova.fluid
    first = volume_path(sysob, max(sysob.nova.frame_start, 1))
    vob = fl.volume
    if vob is None or vob.name not in bpy.data.objects:
        vol = bpy.data.volumes.new(sysob.name + " Fire")
        vob = bpy.data.objects.new(sysob.name + " Fire", vol)
        for coll in sysob.users_collection:
            coll.objects.link(vob)
            break
        fl.volume = vob
    vol = vob.data
    if os.path.exists(first):
        if vol.filepath != first:
            vol.filepath = first
        vol.is_sequence = True
        vol.frame_start = 1
        vol.frame_offset = 0
        vol.frame_duration = sysob.nova.frame_end
        vol.sequence_mode = "CLIP"
    vob.matrix_world = Matrix.Identity(4)
    render.ensure_volume_material(sysob)
    return vob


def refresh_volume(sysob):
    vob = sysob.nova.fluid.volume
    if vob and vob.type == "VOLUME":
        vol = vob.data
        try:
            vol.grids.unload()
        except AttributeError:
            pass
        vol.filepath = vol.filepath
        vob.update_tag()


# ------------------------------------------------------------------ handlers

@bpy.app.handlers.persistent
def on_frame_change(scene, depsgraph=None):
    if STATE["baking"]:
        return
    frame = scene.frame_current
    for sysob in systems(scene):
        n = sysob.nova
        rt = _RT.get(sysob.name)
        live = n.live and not STATE["rendering"] and n.frame_start <= frame <= n.frame_end
        if live and (frame == n.frame_start or (rt and rt.last_frame == frame - 1)):
            try:
                step(scene, sysob, frame, depsgraph)
            except Exception as e:  # never break playback
                print("Nova FX:", e)
            load_frame(sysob, frame)
            if n.fluid.enabled and n.fluid.domain:
                wait_vdb(sysob)
                ensure_volume_object(scene, sysob)
                refresh_volume(sysob)
        else:
            load_frame(sysob, frame)


@bpy.app.handlers.persistent
def on_render_pre(scene, *_):
    STATE["rendering"] = True


@bpy.app.handlers.persistent
def on_render_post(scene, *_):
    STATE["rendering"] = False


@bpy.app.handlers.persistent
def on_load(*_):
    for rt in _RT.values():
        rt.free()
    _RT.clear()


HANDLERS = [
    (bpy.app.handlers.frame_change_post, on_frame_change),
    (bpy.app.handlers.render_pre, on_render_pre),
    (bpy.app.handlers.render_post, on_render_post),
    (bpy.app.handlers.render_cancel, on_render_post),
    (bpy.app.handlers.render_complete, on_render_post),
    (bpy.app.handlers.load_pre, on_load),
]


def register():
    for h, fn in HANDLERS:
        if fn not in h:
            h.append(fn)


def unregister():
    for h, fn in HANDLERS:
        if fn in h:
            h.remove(fn)
    on_load()
