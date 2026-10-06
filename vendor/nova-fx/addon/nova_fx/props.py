import bpy
from bpy.props import (BoolProperty, CollectionProperty, EnumProperty, FloatProperty, FloatVectorProperty,
                       IntProperty, PointerProperty, StringProperty)

from .params import KIND_SPEC

# ------------------------------------------------------------------ particle types

KIND_REF_FIELDS = [n for n, t, _d, _o in KIND_SPEC if t == "K"]


def _rename_kind(self, context):
    """Keep references (death/trail/split/hit) pointing at a renamed type."""
    old = self.get("_prev_name", "")
    if old and old != self.name:
        sysprops = self.id_data.nova
        for k in sysprops.kinds:
            for f in KIND_REF_FIELDS:
                if getattr(k, f) == old:
                    setattr(k, f, self.name)
        for ob in bpy.data.objects:
            em = ob.nova_emitter
            if em.enabled and em.system == self.id_data and em.kind == old:
                em.kind = self.name
    self["_prev_name"] = self.name


def _kind_annotations():
    ann = {"name": StringProperty(name="Name", default="Type", update=_rename_kind),
           "ui_open": StringProperty(default="life,color")}
    for name, t, default, o in KIND_SPEC:
        label = name.replace("_", " ").title()
        desc = o.get("desc", "")
        if t == "F":
            kw = dict(name=label, default=default, description=desc)
            for key in ("min", "max", "soft_min", "soft_max"):
                if key in o:
                    kw[key] = o[key]
            if "unit" in o:
                kw["unit"] = o["unit"]
            ann[name] = FloatProperty(**kw)
        elif t == "I":
            ann[name] = IntProperty(name=label, default=default, description=desc,
                                    min=o.get("min", 0), max=o.get("max", 1 << 30))
        elif t == "B":
            ann[name] = BoolProperty(name=label, default=default, description=desc)
        elif t == "E":
            ann[name] = EnumProperty(name=label, items=o["items"], default=default, description=desc)
        elif t == "K":
            ann[name] = StringProperty(name=label, default="", description=desc)
        elif t == "C":
            ann[name] = FloatVectorProperty(name=label, subtype="COLOR", size=3, min=0, soft_max=1,
                                            default=default, description=desc)
    return ann


NovaKind = type("NovaKind", (bpy.types.PropertyGroup,), {"__annotations__": _kind_annotations()})

# ---------------------------------------------------------------------- fluid

FLUID_SPEC = [
    # name, default, label, kwargs, group
    ("buoy_heat", 2.0, "Heat Lift", dict(soft_min=0, soft_max=10), "physics", "Upward push of hot gas"),
    ("buoy_smoke", 0.3, "Smoke Weight", dict(soft_min=-2, soft_max=5), "physics", "Smoke pulls down (negative floats)"),
    ("vorticity", 0.35, "Vorticity", dict(min=0, soft_max=3), "physics", "Vorticity confinement: restores small swirls"),
    ("turb_amp", 0.0, "Noise", dict(min=0, soft_max=50), "physics", "Curl-noise turbulence where there is smoke or heat"),
    ("turb_freq", 1.0, "Noise Scale", dict(min=0.001, soft_max=20), "physics", "Noise frequency (1/m)"),
    ("turb_speed", 0.5, "Noise Speed", dict(min=0, soft_max=10), "physics", "How fast the noise evolves"),
    ("wind_drag", 0.0, "Wind Pull", dict(min=0, soft_max=5), "physics", "How fast the gas matches the wind (1/s)"),
    ("smoke_decay", 0.02, "Smoke Dissipation", dict(min=0, soft_max=2), "physics", "Smoke fade per second"),
    ("vel_decay", 0.0, "Velocity Damping", dict(min=0, soft_max=5), "physics", "Velocity loss per second"),
    ("cool", 0.4, "Cooling", dict(min=0, soft_max=10), "fire", "Newton cooling (1/s)"),
    ("cool_rad", 0.08, "Radiative Cooling", dict(min=0, soft_max=2), "fire", "T^4 cooling of the hottest gas"),
    ("ignite", 0.25, "Ignition", dict(min=0, soft_max=3), "fire", "Temperature at which fuel burns"),
    ("burn_rate", 2.0, "Burn Rate", dict(min=0, soft_max=20), "fire", "Fuel burned per second"),
    ("heat_release", 1.5, "Heat Release", dict(min=0, soft_max=10), "fire", "Heat made per unit of fuel"),
    ("smoke_yield", 0.6, "Smoke Yield", dict(min=0, soft_max=5), "fire", "Smoke made per unit of fuel"),
    ("expansion", 1.0, "Expansion", dict(min=0, soft_max=20), "fire", "Burning gas expands (explosions push out)"),
    ("flame_decay", 8.0, "Flame Decay", dict(min=0, soft_max=50), "fire", "How fast the flame glow fades after burning"),
    ("fuel_decay", 0.0, "Fuel Dissipation", dict(min=0, soft_max=5), "fire", "Unburnt fuel fade per second"),
    ("cfl", 2.5, "CFL", dict(min=0.5, max=8), "solver", "Cells a fluid substep may move; lower = more substeps"),
    ("cg_tol", 1e-3, "Pressure Tolerance", dict(min=1e-6, max=0.1, precision=5), "solver", "Relative residual"),
]
FLUID_INT_SPEC = [
    ("max_sub", 4, "Max Substeps", 1, 16, "Upper limit on fluid substeps per frame"),
    ("cg_iter", 60, "Max Iterations", 1, 500, "Pressure solver iteration cap (MGPCG converges in ~5)"),
]
FLUID_BOOL_SPEC = [
    ("maccormack", True, "MacCormack", "Second-order advection with clamping: sharper detail"),
    ("reflect", True, "Advection-Reflection", "Energy-preserving step (Zehnder et al. 2018): keeps swirls alive"),
    ("closed_floor", True, "Closed Floor", "The bottom of the domain is a wall"),
    ("sparse", True, "Sparse", "Only simulate tiles that hold smoke, heat or fuel"),
]


def _fluid_annotations():
    ann = {}
    for name, d, label, kw, _g, desc in FLUID_SPEC:
        ann[name] = FloatProperty(name=label, default=d, description=desc, **kw)
    for name, d, label, mn, mx, desc in FLUID_INT_SPEC:
        ann[name] = IntProperty(name=label, default=d, min=mn, max=mx, description=desc)
    for name, d, label, desc in FLUID_BOOL_SPEC:
        ann[name] = BoolProperty(name=label, default=d, description=desc)
    ann["wind"] = FloatVectorProperty(name="Wind", subtype="VELOCITY", size=3, default=(0, 0, 0))
    ann["enabled"] = BoolProperty(name="Fluid", default=False, description="Simulate smoke and fire on a grid")
    ann["device"] = EnumProperty(name="Device", items=[
        ("CPU", "CPU", "Sparse solver on all CPU cores: best when the fire fills a small part of the domain"),
        ("GPU", "GPU", "Vulkan compute on the graphics card: best for big or busy domains"),
    ], default="CPU", description="Where the fire and smoke solver runs (results match to rounding)")
    ann["domain"] = PointerProperty(name="Domain", type=bpy.types.Object,
                                    description="Box object that bounds the fluid")
    ann["resolution"] = IntProperty(name="Resolution", default=96, min=16, max=512,
                                    description="Cells along the longest side of the domain")
    ann["volume"] = PointerProperty(name="Volume Object", type=bpy.types.Object)
    ann["write_velocity"] = BoolProperty(name="Velocity Grid", default=False,
                                         description="Also write velocity to the VDB (volume motion blur, bigger files)")
    ann["density_mult"] = FloatProperty(name="Smoke Density", default=6.0, min=0, soft_max=100,
                                        update=lambda s, c: _material_update(s, c))
    ann["flame_mult"] = FloatProperty(name="Flame Brightness", default=6.0, min=0, soft_max=200,
                                      update=lambda s, c: _material_update(s, c))
    ann["heat_mult"] = FloatProperty(name="Heat Glow", default=2.0, min=0, soft_max=100,
                                     update=lambda s, c: _material_update(s, c))
    ann["temp_scale"] = FloatProperty(name="Flame Temperature", default=1500.0, min=100, soft_max=5000,
                                      description="Kelvin added per unit of heat (colour of the flame)",
                                      update=lambda s, c: _material_update(s, c))
    ann["smoke_color"] = FloatVectorProperty(name="Smoke Color", subtype="COLOR", size=3, min=0, max=1,
                                             default=(0.12, 0.11, 0.1), update=lambda s, c: _material_update(s, c))
    return ann


def _material_update(self, context):
    from . import render
    render.sync_materials(self.id_data)


NovaFluid = type("NovaFluid", (bpy.types.PropertyGroup,), {"__annotations__": _fluid_annotations()})

# --------------------------------------------------------------------- system


def _display_update(self, context):
    from . import render, sim
    render.sync_display(self.id_data)
    render.sync_materials(self.id_data)
    sim.reload_frame(self.id_data, context.scene)


class NovaSystem(bpy.types.PropertyGroup):
    is_system: BoolProperty(default=False)
    kinds: CollectionProperty(type=NovaKind)
    kinds_index: IntProperty(default=0)
    frame_start: IntProperty(name="Start", default=1)
    frame_end: IntProperty(name="End", default=250)
    substeps: IntProperty(name="Substeps", default=2, min=1, max=64,
                          description="Particle substeps per frame (fast sparks and collisions want more)")
    time_scale: FloatProperty(name="Time Scale", default=1.0, min=0.01, soft_max=4,
                              description="Simulation speed (below 1 = slow motion)")
    max_particles: IntProperty(name="Max Particles", default=2_000_000, min=1, max=200_000_000)
    seed: IntProperty(name="Seed", default=0, min=0)
    gravity: FloatVectorProperty(name="Gravity", subtype="ACCELERATION", size=3, default=(0, 0, -9.81))
    wind: FloatVectorProperty(name="Wind", subtype="VELOCITY", size=3, default=(0, 0, 0))
    turb_amp: FloatProperty(name="Turbulence", default=0.0, min=0, soft_max=100,
                            description="Curl-noise turbulence (divergence free: swirls without clumping)")
    turb_freq: FloatProperty(name="Scale", default=0.5, min=0.001, soft_max=20, description="Noise frequency (1/m)")
    turb_speed: FloatProperty(name="Evolution", default=0.5, min=0, soft_max=10)
    turb_octaves: IntProperty(name="Detail", default=2, min=1, max=6)
    t_ambient: FloatProperty(name="Ambient Temperature", default=293.0, min=0, soft_max=1000)
    cache_dir: StringProperty(name="Cache", subtype="DIR_PATH", default="//nova_cache/")
    live: BoolProperty(name="Live Preview", default=True,
                       description="Simulate while the timeline plays forward; jump back to the start to reset")
    display: EnumProperty(name="Display", items=[
        ("POINTS", "Points", "Spheres (Cycles motion blur uses the velocity attribute)"),
        ("STREAKS", "Streaks", "Stretch each particle along its motion (works in EEVEE and Cycles)"),
    ], default="POINTS", update=_display_update)
    streak_length: FloatProperty(name="Streak Length", default=0.03, min=0, soft_max=0.5, unit="TIME_ABSOLUTE",
                                 description="Seconds of motion each streak covers", update=_display_update)
    viewport_pct: IntProperty(name="Viewport %", default=100, min=1, max=100, subtype="PERCENTAGE",
                              description="Share of particles shown in the viewport (renders always use all)",
                              update=_display_update)
    size_mult: FloatProperty(name="Size", default=1.0, min=0, soft_max=10, update=_display_update)
    emission_mult: FloatProperty(name="Brightness", default=1.0, min=0, soft_max=50, update=_display_update)
    shading: EnumProperty(name="Shading", items=[
        ("EMISSIVE", "Glowing", "Pure light (sparks, fire, fireworks)"),
        ("LIT", "Lit", "Lit by the scene (snow, dust, debris)"),
    ], default="EMISSIVE", update=_display_update)
    fluid: PointerProperty(type=NovaFluid)


# -------------------------------------------------------------------- emitter


def _poll_system(self, ob):
    return ob.nova.is_system


class NovaEmitter(bpy.types.PropertyGroup):
    enabled: BoolProperty(default=False)
    system: PointerProperty(name="System", type=bpy.types.Object, poll=_poll_system)
    kind: StringProperty(name="Type", description="Particle type this emitter births")
    shape: EnumProperty(name="Shape", items=[
        ("POINT", "Point", "From the object origin"),
        ("SPHERE", "Sphere", "From inside a sphere around the origin"),
        ("SURFACE", "Surface", "From the mesh surface (area weighted)"),
        ("VERTS", "Vertices", "From mesh vertices"),
    ], default="POINT")
    radius: FloatProperty(name="Radius", default=0.1, min=0, soft_max=10, unit="LENGTH")
    deforming: BoolProperty(name="Deforming", default=False, description="Re-read the mesh every frame")
    rate: FloatProperty(name="Rate", default=500, min=0, soft_max=100000,
                        description="Particles per second (animatable)")
    random_timing: BoolProperty(name="Random Timing", default=False,
                                description="Births arrive at random moments (Poisson) instead of evenly")
    burst: IntProperty(name="Burst", default=0, min=0, description="Extra particles at the burst frame")
    burst_frame: IntProperty(name="Burst Frame", default=1)
    frame_start: IntProperty(name="Start", default=1)
    frame_end: IntProperty(name="End", default=250)
    direction: EnumProperty(name="Direction", items=[
        ("NORMAL", "Normal", "Surface normal (origin for Point/Sphere: outward)"),
        ("OBJECT_Z", "Object Z", "Along the object's local Z axis"),
        ("RANDOM", "Random", "Any direction"),
    ], default="OBJECT_Z")
    speed: FloatProperty(name="Speed", default=5.0, min=0, soft_max=200, unit="VELOCITY")
    speed_var: FloatProperty(name="Speed Variation", default=0.2, min=0, max=1)
    spread: FloatProperty(name="Spread", default=0.2, min=0, max=3.14159, subtype="ANGLE",
                          description="Cone angle around the direction")
    inherit: FloatProperty(name="Inherit Motion", default=0.0, soft_min=0, soft_max=1,
                           description="Share of the emitter's own velocity")
    seed: IntProperty(name="Seed", default=0, min=0)
    # fluid source
    fl_enabled: BoolProperty(name="Fluid Source", default=False)
    fl_density: FloatProperty(name="Smoke", default=0.0, min=0, soft_max=10)
    fl_heat: FloatProperty(name="Heat", default=1.0, min=0, soft_max=10)
    fl_fuel: FloatProperty(name="Fuel", default=1.0, min=0, soft_max=10)
    fl_radius: FloatProperty(name="Splat Radius", default=0.0, min=0, soft_max=2, unit="LENGTH",
                             description="0 = automatic (1.5 cells)")
    fl_speed: FloatProperty(name="Jet Speed", default=0.0, soft_min=0, soft_max=50, unit="VELOCITY",
                            description="Push the gas along the emit direction")
    fl_points: IntProperty(name="Samples", default=0, min=0, max=200000,
                           description="Source points per frame (0 = automatic)")
    fl_noise: FloatProperty(name="Source Noise", default=0.5, min=0, max=1,
                            description="Break up the source with noise so flames lick")


class NovaCollider(bpy.types.PropertyGroup):
    enabled: BoolProperty(default=False)
    shape: EnumProperty(name="Shape", items=[
        ("PLANE", "Plane", "Infinite plane through the object, normal = local Z"),
        ("SPHERE", "Sphere", "Sphere from the object bounds"),
        ("BOX", "Box", "Box from the object bounds"),
        ("MESH", "Mesh", "The exact mesh shape (baked to a signed distance field)"),
    ], default="PLANE")
    sdf_res: IntProperty(name="Resolution", default=64, min=8, max=256,
                         description="Distance-field cells along the longest side")
    deforming: BoolProperty(name="Deforming", default=False,
                            description="Re-bake the shape every frame (animated or deforming meshes)")


class NovaForce(bpy.types.PropertyGroup):
    enabled: BoolProperty(default=False)
    type: EnumProperty(name="Type", items=[
        ("ATTRACT", "Attract", "Pull toward the object (negative pushes)"),
        ("VORTEX", "Vortex", "Swirl around the object's Z axis"),
        ("WIND", "Wind", "Moves air along local Z (acts through drag)"),
        ("TURBULENCE", "Turbulence", "Local curl noise"),
        ("DRAG", "Drag", "Slow particles down"),
    ], default="ATTRACT")
    strength: FloatProperty(name="Strength", default=5.0, soft_min=-100, soft_max=100)
    radius: FloatProperty(name="Radius", default=0.0, min=0, soft_max=100, unit="LENGTH",
                          description="Falloff distance (0 = everywhere)")
    falloff: FloatProperty(name="Falloff", default=2.0, min=0, soft_max=4,
                           description="0 = hard edge at radius, 2 = inverse square beyond radius")
    freq: FloatProperty(name="Scale", default=1.0, min=0.001, soft_max=20)


CLASSES = (NovaKind, NovaFluid, NovaSystem, NovaEmitter, NovaCollider, NovaForce)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.nova = PointerProperty(type=NovaSystem)
    bpy.types.Object.nova_emitter = PointerProperty(type=NovaEmitter)
    bpy.types.Object.nova_collider = PointerProperty(type=NovaCollider)
    bpy.types.Object.nova_force = PointerProperty(type=NovaForce)


def unregister():
    del bpy.types.Object.nova_force
    del bpy.types.Object.nova_collider
    del bpy.types.Object.nova_emitter
    del bpy.types.Object.nova
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
