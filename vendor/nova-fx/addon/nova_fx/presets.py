"""Ready-made effects. Each builder creates a system, its particle types, emitters and helpers."""

import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

from . import render, sim
from .params import chem

# ------------------------------------------------------------------ building blocks


def _collection(context, name):
    coll = bpy.data.collections.new(name)
    context.scene.collection.children.link(coll)
    return coll


def new_system(context, coll, name, kinds, frame_end=None, **settings):
    pc = bpy.data.pointclouds.new(name)
    ob = bpy.data.objects.new(name, pc)
    coll.objects.link(ob)
    n = ob.nova
    n.is_system = True
    scene = context.scene
    n.frame_start = scene.frame_start
    n.frame_end = frame_end or scene.frame_end
    for kd in kinds:
        k = n.kinds.add()
        for key, val in kd.items():
            setattr(k, key, val)
        k["_prev_name"] = k.name
    for key, val in settings.items():
        if key == "fluid":
            for fk, fv in val.items():
                setattr(n.fluid, fk, fv)
        else:
            setattr(n, key, val)
    render.sync_display(ob)
    render.sync_materials(ob)
    scene.render.use_lock_interface = True  # handlers swap point data while rendering
    return ob


def _empty(coll, name, loc, rot=(0, 0, 0), kind="SPHERE", size=0.1, scale=(1, 1, 1)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = kind
    ob.empty_display_size = size
    ob.location = loc
    ob.rotation_euler = rot
    ob.scale = scale
    coll.objects.link(ob)
    return ob


def emitter(coll, sysob, name, kind, loc, rot=(0, 0, 0), display="SPHERE", size=0.1, scale=(1, 1, 1), ob=None,
            **em):
    ob = ob or _empty(coll, name, loc, rot, display, size, scale)
    e = ob.nova_emitter
    e.enabled = True
    e.system = sysob
    e.kind = kind
    e.frame_start = sysob.nova.frame_start
    e.frame_end = sysob.nova.frame_end
    for key, val in em.items():
        setattr(e, key, val)
    return ob


def _mesh(coll, name, build, loc=(0, 0, 0), rot=(0, 0, 0), mat=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = rot
    coll.objects.link(ob)
    if mat:
        me.materials.append(mat)
    return ob


def _charred_wood(name="Nova Charred Wood"):
    """Black, cracked bark; the cracks glow like embers (emission masked by Voronoi cell edges)."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.9
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 22.0
    vor.inputs["Randomness"].default_value = 0.9
    crack = nt.nodes.new("ShaderNodeMapRange")          # thin bright lines along the cell edges
    crack.inputs["From Min"].default_value = 0.0
    crack.inputs["From Max"].default_value = 0.06
    crack.inputs["To Min"].default_value = 1.0
    crack.inputs["To Max"].default_value = 0.0
    noise = nt.nodes.new("ShaderNodeTexNoise")          # not every crack is equally hot
    noise.inputs["Scale"].default_value = 4.0
    heat = nt.nodes.new("ShaderNodeMath")
    heat.operation = "MULTIPLY"
    hot = nt.nodes.new("ShaderNodeMapRange")
    hot.inputs["From Min"].default_value = 0.45
    hot.inputs["From Max"].default_value = 0.7
    strength = nt.nodes.new("ShaderNodeMath")
    strength.operation = "MULTIPLY"
    strength.inputs[1].default_value = 6.0
    bark = nt.nodes.new("ShaderNodeValToRGB")          # ash-grey to black bark
    bark.color_ramp.elements[0].color = (0.006, 0.005, 0.004, 1)
    bark.color_ramp.elements[1].color = (0.05, 0.045, 0.04, 1)
    L = nt.links.new
    L(vor.outputs["Distance"], crack.inputs["Value"])
    L(noise.outputs["Fac"], hot.inputs["Value"])
    L(crack.outputs["Result"], heat.inputs[0])
    L(hot.outputs["Result"], heat.inputs[1])
    L(heat.outputs["Value"], strength.inputs[0])
    L(strength.outputs["Value"], bsdf.inputs["Emission Strength"])
    L(noise.outputs["Fac"], bark.inputs["Fac"])
    L(bark.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Emission Color"].default_value = (1.0, 0.22, 0.03, 1)
    mat.diffuse_color = (0.02, 0.015, 0.012, 1)
    return mat


def _plain_material(name, color, rough=0.8, emit=None, emit_strength=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if not mat.node_tree:
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
        bsdf.inputs["Roughness"].default_value = rough
        if emit:
            bsdf.inputs["Emission Color"].default_value = (*emit, 1)
            bsdf.inputs["Emission Strength"].default_value = emit_strength
    mat.diffuse_color = (*color, 1)
    return mat


def ground(coll, size=20.0, z=0.0, visible=True, name="Nova Ground"):
    ob = _mesh(coll, name, lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=size / 2),
               (0, 0, z), mat=_plain_material("Nova Ground", (0.05, 0.05, 0.05), 0.6))
    ob.nova_collider.enabled = True
    ob.nova_collider.shape = "PLANE"
    if not visible:
        ob.hide_render = True
        ob.display_type = "WIRE"
    return ob


def domain(coll, sysob, size, center, resolution, **fluid):
    ob = _mesh(coll, sysob.name + " Domain",
               lambda bm: bmesh.ops.create_cube(bm, size=1.0), center)
    ob.scale = size
    ob.display_type = "BOUNDS"
    ob.hide_render = True
    fl = sysob.nova.fluid
    fl.enabled = True
    fl.domain = ob
    fl.resolution = resolution
    for k, v in fluid.items():
        setattr(fl, k, v)
    return ob


def camera(context, coll, loc, target, lens=35.0):
    cam = bpy.data.cameras.new("Nova Camera")
    cam.lens = lens
    cam.clip_end = 2000
    ob = bpy.data.objects.new("Nova Camera", cam)
    ob.location = loc
    d = Vector(target) - Vector(loc)
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    coll.objects.link(ob)
    context.scene.camera = ob
    return ob


def night_world(context, color=(0.0015, 0.002, 0.005)):
    w = bpy.data.worlds.get("Nova Night") or bpy.data.worlds.new("Nova Night")
    if not w.node_tree:
        w.use_nodes = True
    bg = next((n for n in w.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs["Color"].default_value = (*color, 1)
        bg.inputs["Strength"].default_value = 1.0
    context.scene.world = w


def _offset(coll, offset):
    for ob in coll.objects:
        if ob.parent is None and ob.type != "CAMERA":
            ob.location = Vector(ob.location) + offset


# ------------------------------------------------------------------ shared particle types

def bb(name, T, life, size, emit, **kw):
    """Incandescent (blackbody) type."""
    d = dict(name=name, color_mode="BLACKBODY", temp0=T, temp_var=kw.pop("temp_var", 0.1 * T),
             life_min=life[0], life_max=life[1], size_start=size[0], size_end=size[1], emit=emit,
             collide=kw.pop("collide", "NONE"), fade_in=0.0, fade_out=kw.pop("fade_out", 0.15))
    d.update(kw)
    return d


def col(name, color, life, size, emit, **kw):
    d = dict(name=name, color_mode="FIXED", color=color, life_min=life[0], life_max=life[1], size_start=size[0],
             size_end=size[1], emit=emit, collide=kw.pop("collide", "NONE"), fade_in=0.0,
             fade_out=kw.pop("fade_out", 0.35), color_var=kw.pop("color_var", 0.05))
    d.update(kw)
    return d


# ------------------------------------------------------------------ presets

def build_sparkler(context, coll):
    s = new_system(context, coll, "Sparkler", [
        bb("Spark", 2500, (0.15, 0.4), (0.0008, 0.0003), 40, size_var=0.35, drag_quad=25.0, drag_lin=0.5,
           cool=2.5, cool_rad=1.0, emit_var=0.3, gravity=0.6, split_kind="Spark", split_rate=4.0, split_count=3,
           split_speed=1.3, split_inherit=0.5, split_max_gen=3),
        bb("Core Glow", 2900, (0.04, 0.08), (0.004, 0.002), 80, size_var=0.3, emit_var=0.4, gravity=0.0),
    ], display="STREAKS", streak_length=0.015, substeps=3)
    stick_mat = _plain_material("Nova Sparkler Wire", (0.25, 0.25, 0.27), 0.4)
    _mesh(coll, "Sparkler Wire",
          lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.0015, radius2=0.0015,
                                           depth=0.35), (0, 0, 0.9), (0.6, 0, 0), stick_mat)
    tip = Vector((0, 0, 0.9)) + Euler((0.6, 0, 0)).to_matrix() @ Vector((0, 0, 0.12))
    burn_mat = _plain_material("Nova Sparkler Burn", (0.05, 0.04, 0.03), 0.7, (1.0, 0.45, 0.12), 25.0)
    _mesh(coll, "Sparkler Coating",
          lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.004, radius2=0.004,
                                           depth=0.11),
          Vector((0, 0, 0.9)) + Euler((0.6, 0, 0)).to_matrix() @ Vector((0, 0, 0.065)), (0.6, 0, 0), burn_mat)
    emitter(coll, s, "Sparkler Tip", "Spark", tip, size=0.02, shape="SPHERE", radius=0.008, direction="RANDOM",
            rate=700, speed=3.0, speed_var=0.45)
    emitter(coll, s, "Sparkler Core", "Core Glow", tip, size=0.015, shape="SPHERE", radius=0.006,
            direction="RANDOM", rate=400, speed=0.15, speed_var=0.5)
    return s


def build_grinder(context, coll):
    s = new_system(context, coll, "Grinder Sparks", [
        bb("Spark", 2300, (0.6, 1.4), (0.004, 0.0015), 30, drag_quad=0.25, cool=1.2, cool_rad=0.4,
           collide="BOUNCE", bounce=0.35, friction=0.35, hit_kind="Spatter", hit_count=0.7, hit_speed=2.5,
           split_kind="Spatter", split_rate=0.8, split_count=3, split_speed=1.5, split_max_gen=1),
        bb("Spatter", 2100, (0.15, 0.4), (0.0025, 0.001), 20, drag_quad=1.0, cool=3.0, collide="BOUNCE",
           bounce=0.2, friction=0.4),
    ], display="STREAKS", streak_length=0.02, substeps=2)
    ground(coll, 10)
    emitter(coll, s, "Grinder Contact", "Spark", (0, 0, 0.6), (math.radians(115), 0, 0), "SINGLE_ARROW", 0.25,
            shape="POINT", direction="OBJECT_Z", spread=0.18, rate=4000, speed=14, speed_var=0.35)
    return s


def build_fountain(context, coll):
    s = new_system(context, coll, "Fountain", [
        bb("Spark", 2000, (0.9, 1.6), (0.006, 0.002), 25, temp_var=150, drag_quad=0.35, cool=0.8, collide="BOUNCE",
           bounce=0.25, friction=0.3, split_kind="Glitter", split_rate=1.2, split_count=4, split_speed=1.8,
           split_max_gen=1),
        bb("Glitter", 2600, (0.1, 0.35), (0.004, 0.002), 60, drag_quad=1.0, cool=3.0, twinkle_freq=15,
           twinkle_amt=0.7),
    ], display="STREAKS", streak_length=0.03, substeps=2)
    ground(coll, 12)
    emitter(coll, s, "Fountain Nozzle", "Spark", (0, 0, 0.05), (0, 0, 0), "SINGLE_ARROW", 0.3, shape="POINT",
            direction="OBJECT_Z", spread=0.22, rate=3000, speed=8.5, speed_var=0.25)
    return s


# fireworks ----------------------------------------------------------------

def _shell(name, star, count, pattern, speed, trail_rate=90, life=(2.6, 3.1), **kw):
    d = bb("Shell " + name, 1900, life, (0.14, 0.1), 6, temp_var=100, drag_quad=0.006, cool=0.1,
           trail_kind="Lift Spark", trail_rate=trail_rate, trail_inherit=0.05, trail_jitter=1.5,
           death_kind=star, death_count=count, death_pattern=pattern, death_speed=speed, death_speed_var=0.08,
           death_inherit=0.25, fade_out=0.0)
    d.update(kw)
    return d


FIREWORK_KINDS = [
    bb("Lift Spark", 1900, (0.3, 0.7), (0.09, 0.03), 40, temp_var=150, drag_quad=0.3, cool=1.5),
    col("Ember", (1, 0.5, 0.2), (0.3, 0.7), (0.1, 0.0), 40, inherit_color=True, drag_lin=1.5, gravity=0.3,
        fade_out=0.8),
    bb("Gold Glitter", 2000, (0.5, 1.2), (0.1, 0.02), 60, temp_var=200, drag_lin=2.0, gravity=0.4, cool=0.9,
       twinkle_freq=9, twinkle_amt=0.5),
    bb("Willow Trail", 1800, (1.8, 3.0), (0.11, 0.03), 40, temp_var=120, drag_lin=2.5, gravity=0.25, cool=0.45,
       fade_out=0.6),
    col("Crackle", (1, 0.85, 0.6), (0.04, 0.12), (0.4, 0.08), 900, emit_var=0.5, drag_lin=3.0, gravity=0.0,
        fade_out=0.5),
    # stars
    col("Peony Star", chem("STRONTIUM"), (1.6, 2.2), (0.32, 0.2), 300, drag_quad=0.07, trail_kind="Ember",
        trail_rate=25),
    bb("Chrysanthemum Star", 2300, (1.8, 2.4), (0.26, 0.16), 160, drag_quad=0.07, trail_kind="Gold Glitter",
       trail_rate=60, cool=0.2),
    bb("Willow Star", 1900, (3.5, 4.5), (0.2, 0.12), 120, drag_quad=0.25, gravity=0.6, cool=0.12,
       trail_kind="Willow Trail", trail_rate=70),
    bb("Palm Arm", 2200, (2.2, 2.8), (0.4, 0.24), 220, drag_quad=0.04, cool=0.15, trail_kind="Gold Glitter",
       trail_rate=150),
    col("Ring Star", chem("COPPER"), (1.5, 2.0), (0.32, 0.2), 320, drag_quad=0.07, trail_kind="Ember",
        trail_rate=15),
    col("Crossette Star", chem("BARIUM"), (0.9, 1.1), (0.32, 0.28), 260, drag_quad=0.05, fade_out=0.0,
        death_kind="Crossette Piece", death_count=4, death_pattern="CROSS", death_speed=9, death_inherit=0.6),
    col("Crossette Piece", chem("BARIUM"), (0.9, 1.3), (0.26, 0.14), 240, inherit_color=True, drag_quad=0.07,
        trail_kind="Ember", trail_rate=25),
    col("Crackle Star", chem("PURPLE"), (1.4, 1.8), (0.3, 0.2), 280, drag_quad=0.07, death_kind="Crackle",
        death_count=10, death_pattern="RANDOM", death_speed=4),
    col("Strobe Star", (1, 1, 1), (2.0, 2.8), (0.3, 0.22), 300, drag_quad=0.06, twinkle_freq=14,
        twinkle_amt=1.0, color_var=0.0),
    col("Heart Star", (1.0, 0.25, 0.55), (1.8, 2.2), (0.32, 0.2), 300, drag_quad=0.05, gravity=0.6,
        trail_kind="Ember", trail_rate=15),
    col("Rainbow Star", (1, 0.3, 0.1), (1.6, 2.2), (0.32, 0.2), 280, inherit_color=True, drag_quad=0.07,
        trail_kind="Ember", trail_rate=20),
    dict(col("Change Star", chem("BARIUM"), (1.8, 2.4), (0.32, 0.2), 280, drag_quad=0.07, trail_kind="Ember",
             trail_rate=20), color_mode="GRADIENT", color2=chem("STRONTIUM"), color_curve=2.0),
    # shells (rise, then burst)
    _shell("Peony", "Peony Star", 150, "SPHERE", 24),
    _shell("Chrysanthemum", "Chrysanthemum Star", 160, "SPHERE", 26),
    _shell("Willow", "Willow Star", 110, "SPHERE", 22),
    _shell("Palm", "Palm Arm", 8, "PALM", 30, trail_rate=220),
    _shell("Ring", "Ring Star", 64, "RING", 22),
    _shell("Crossette", "Crossette Star", 24, "SPHERE", 20),
    _shell("Crackle", "Crackle Star", 120, "SPHERE", 22),
    _shell("Strobe", "Strobe Star", 140, "SPHERE", 22),
    _shell("Heart", "Heart Star", 90, "HEART", 22),
    dict(_shell("Multicolor", "Rainbow Star", 150, "SPHERE", 24), hue_random=1.0, color_mode="FIXED",
         color=(1, 0.2, 0.1)),
    _shell("Color Change", "Change Star", 150, "SPHERE", 24),
]

SHELLS = ["Peony", "Chrysanthemum", "Willow", "Palm", "Ring", "Crossette", "Crackle", "Strobe", "Heart",
          "Multicolor", "Color Change"]


def build_fireworks(context, coll, shells=None, rate=0.2):
    shells = shells or SHELLS
    s = new_system(context, coll, "Fireworks", FIREWORK_KINDS, display="STREAKS", streak_length=0.04,
                   substeps=2, max_particles=4_000_000)
    span = 120.0
    for i, name in enumerate(shells):
        x = -span / 2 + span * (i + 0.5) / len(shells)
        tilt = math.radians(6) * math.sin(i * 2.1)
        emitter(coll, s, f"Launcher {name}", "Shell " + name, (x, 0, 0), (tilt, 0, 0), "SINGLE_ARROW", 3.0,
                shape="POINT", direction="OBJECT_Z", spread=math.radians(5), rate=rate, random_timing=True,
                speed=48, speed_var=0.08, seed=i * 7 + 1)
    return s


# fire ---------------------------------------------------------------------

def build_campfire(context, coll):
    s = new_system(context, coll, "Campfire", [
        bb("Ember", 1500, (2.0, 4.5), (0.006, 0.003), 18, temp_var=250, cool=0.25, cool_rad=0.5, fluid_drag=3.0,
           drag_lin=0.3, twinkle_freq=4, twinkle_amt=0.5, fade_out=0.3, collide="BOUNCE", bounce=0.1),
        bb("Pop Spark", 2100, (0.3, 0.8), (0.004, 0.0015), 30, drag_quad=0.6, cool=2.0, fluid_drag=0.8),
    ], turb_amp=2.5, turb_freq=1.5, substeps=2,
        fluid=dict(buoy_heat=2.2, buoy_smoke=0.15, vorticity=0.7, turb_amp=7.0, turb_freq=4.0, cool=1.4,
                   cool_rad=0.4, burn_rate=1.8, heat_release=1.6, ignite=0.2, smoke_yield=0.35, expansion=0.4,
                   flame_decay=6.0, smoke_decay=0.15, density_mult=4.0, flame_mult=2.0, heat_mult=1.2))
    domain(coll, s, (1.6, 1.6, 2.6), (0, 0, 1.3), 96)
    ground(coll, 8)
    log_mat = _charred_wood()
    for i in range(4):
        a = i * math.pi / 2 + 0.4
        _mesh(coll, f"Log {i + 1}", lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=10,
                                                                      radius1=0.06, radius2=0.05, depth=0.7),
              (0.18 * math.cos(a), 0.18 * math.sin(a), 0.12), (math.radians(70), 0, a + math.pi / 2), log_mat)
    emitter(coll, s, "Fire Source", "", (0, 0, 0.14), size=0.25, scale=(1, 1, 0.4), shape="SPHERE", radius=0.25,
            rate=0, fl_enabled=True, fl_fuel=1.4, fl_heat=0.8, fl_speed=0.6, fl_noise=0.7, direction="OBJECT_Z")
    emitter(coll, s, "Ember Source", "Ember", (0, 0, 0.2), size=0.2, shape="SPHERE", radius=0.2, rate=25,
            speed=1.2, speed_var=0.6, spread=0.6)
    emitter(coll, s, "Pops", "Pop Spark", (0, 0, 0.18), size=0.15, shape="SPHERE", radius=0.15, rate=10,
            random_timing=True, speed=4, speed_var=0.5, spread=0.9)
    return s


def build_torch(context, coll):
    s = new_system(context, coll, "Torch", [
        bb("Ember", 1600, (1.0, 2.0), (0.004, 0.002), 14, cool=0.4, fluid_drag=4.0, twinkle_freq=5,
           twinkle_amt=0.4),
    ], turb_amp=1.5, turb_freq=3.0,
        fluid=dict(buoy_heat=3.0, buoy_smoke=0.1, vorticity=0.5, turb_amp=3.0, turb_freq=6.0, cool=1.8,
                   cool_rad=0.4, burn_rate=4.0, heat_release=1.6, smoke_yield=0.15, expansion=0.3,
                   flame_decay=8.0, smoke_decay=0.3, density_mult=3.0, flame_mult=9.0, heat_mult=3.0))
    domain(coll, s, (0.8, 0.8, 1.4), (0, 0, 1.62), 80)
    handle_mat = _plain_material("Nova Torch Handle", (0.08, 0.05, 0.03), 0.8)
    _mesh(coll, "Torch Handle", lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=0.02,
                                                                 radius2=0.035, depth=0.6), (0, 0, 0.62),
          mat=handle_mat)
    emitter(coll, s, "Torch Flame", "Ember", (0, 0, 0.98), size=0.06, shape="SPHERE", radius=0.05, rate=8,
            speed=0.8, fl_enabled=True, fl_fuel=1.2, fl_heat=1.0, fl_speed=1.2, fl_noise=0.6)
    return s


def build_explosion(context, coll):
    s = new_system(context, coll, "Explosion", [
        bb("Debris", 1800, (1.0, 2.5), (0.05, 0.025), 12, drag_quad=0.05, cool=0.7, collide="BOUNCE", bounce=0.3,
           trail_kind="Debris Trail", trail_rate=30, fl_smoke=1.5, fl_heat=0.6),
        bb("Debris Trail", 1600, (0.3, 0.8), (0.035, 0.0), 6, drag_lin=2.0, cool=1.0),
    ], frame_end=120, substeps=2,
        fluid=dict(buoy_heat=3.0, buoy_smoke=0.04, vorticity=1.0, turb_amp=5.0, turb_freq=0.5, cool=0.5,
                   cool_rad=0.12, burn_rate=3.0, heat_release=2.0, ignite=0.15, smoke_yield=1.5, expansion=8.0,
                   flame_decay=2.5, smoke_decay=0.02, density_mult=1.2, flame_mult=3.0, heat_mult=0.8,
                   max_sub=4, smoke_color=(0.22, 0.21, 0.2)))
    domain(coll, s, (16, 16, 16), (0, 0, 8), 96)
    ground(coll, 60)
    emitter(coll, s, "Blast Core", "", (0, 0, 1.5), size=1.2, shape="SPHERE", radius=1.2, rate=0,
            fl_enabled=True, fl_fuel=4.0, fl_heat=1.5, fl_density=0.5, fl_noise=0.6, frame_end=context.scene.frame_start + 1)
    emitter(coll, s, "Debris Burst", "Debris", (0, 0, 1.5), size=0.5, shape="SPHERE", radius=0.5, rate=0,
            burst=150, burst_frame=context.scene.frame_start, direction="NORMAL", speed=24, speed_var=0.5,
            spread=0.3)
    sun = bpy.data.lights.new("Nova Sun", "SUN")
    sun.energy = 2.0
    sun_ob = bpy.data.objects.new("Nova Sun", sun)
    sun_ob.rotation_euler = (math.radians(55), 0, math.radians(-35))
    coll.objects.link(sun_ob)
    return s


# magic --------------------------------------------------------------------

def build_magic_dust(context, coll):
    s = new_system(context, coll, "Magic Dust", [
        dict(name="Dust", color_mode="GRADIENT", color=(0.25, 0.7, 1.0), color2=(0.9, 0.3, 1.0), color_var=0.3,
             life_min=0.8, life_max=2.0, size_start=0.012, size_end=0.0, size_curve=0.7, gravity=-0.05,
             drag_lin=2.5, emit=1.8, emit_var=0.6, twinkle_freq=10, twinkle_amt=0.75, fade_in=0.05,
             fade_out=0.6, collide="NONE"),
        col("Glint", (1, 0.95, 0.85), (0.15, 0.4), (0.03, 0.0), 120, drag_lin=3, gravity=0.0, fade_out=0.8),
    ], turb_amp=3.0, turb_freq=2.0, turb_speed=1.0)
    wand = emitter(coll, s, "Wand Tip", "Dust", (0, 0, 1.2), size=0.05, shape="SPHERE", radius=0.03, rate=1500,
                   direction="RANDOM", speed=0.25, speed_var=0.5, inherit=0.25)
    emitter(coll, s, "Wand Glints", "Glint", (0, 0, 0), size=0.03, shape="SPHERE", radius=0.04, rate=40,
            direction="RANDOM", speed=0.4).parent = wand
    # a figure-eight flight path so it looks right on the first play
    f0, f1 = context.scene.frame_start, context.scene.frame_start + 119
    for i in range(13):
        t = i / 12
        a = t * 2 * math.pi
        wand.location = (1.2 * math.sin(a), 0.6 * math.sin(2 * a), 1.2 + 0.25 * math.sin(3 * a))
        wand.keyframe_insert("location", frame=f0 + t * (f1 - f0))
    return s


def build_embers(context, coll):
    s = new_system(context, coll, "Drifting Embers", [
        bb("Ember", 1400, (4.0, 8.0), (0.012, 0.006), 14, temp_var=250, cool=0.15, cool_rad=0.3, gravity=0.0,
           buoyancy=0.6, drag_lin=1.0, twinkle_freq=3, twinkle_amt=0.4, fade_in=0.1, fade_out=0.3),
    ], turb_amp=1.5, turb_freq=0.6, wind=(1.0, 0, 0))
    _plane = _mesh(coll, "Ember Field", lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=3),
                   (0, 0, 0.05))
    _plane.hide_render = True
    _plane.display_type = "WIRE"
    emitter(coll, s, "Ember Field", "Ember", None, ob=_plane, shape="SURFACE", rate=150, speed=0.6, spread=0.5,
            direction="NORMAL")
    return s


def build_vortex(context, coll):
    s = new_system(context, coll, "Energy Vortex", [
        dict(name="Energy", color_mode="GRADIENT", color=(0.2, 0.55, 1.0), color2=(0.75, 0.2, 1.0), color_var=0.25,
             color_curve=0.7, life_min=4, life_max=6, size_start=0.012, size_end=0.004, gravity=0.0, drag_lin=0.8,
             emit=1.6, emit_var=0.5, twinkle_freq=3, twinkle_amt=0.3, fade_in=0.1, fade_out=0.4, collide="NONE"),
    ], turb_amp=0.6, turb_freq=0.8, display="STREAKS", streak_length=0.12)
    emitter(coll, s, "Energy Disc", "Energy", (0, 0, 0), size=3.5, scale=(1, 1, 0.08), shape="SPHERE", radius=3.5,
            rate=1500, direction="RANDOM", speed=0.2)
    for name, t, st, r in (("Vortex", "VORTEX", 5.0, 0.0), ("Core Pull", "ATTRACT", 1.2, 3.0)):
        ob = _empty(coll, name, (0, 0, 0), kind="CIRCLE" if t == "VORTEX" else "SPHERE", size=1.5)
        f = ob.nova_force
        f.enabled, f.type, f.strength, f.radius = True, t, st, r
    return s


def build_snow(context, coll):
    s = new_system(context, coll, "Snow", [
        col("Flake", (0.95, 0.97, 1.0), (15, 20), (0.008, 0.008), 0.0, drag_lin=8.0, collide="STICK",
            fade_out=0.05, color_var=0.0),
    ], turb_amp=1.0, turb_freq=0.3, wind=(0.5, 0, 0), shading="LIT")
    sky = _mesh(coll, "Snow Sky", lambda bm: bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=10),
                (0, 0, 10))
    sky.hide_render = True
    sky.display_type = "WIRE"
    emitter(coll, s, "Snow Sky", "Flake", None, ob=sky, shape="SURFACE", rate=800, direction="RANDOM", speed=0.2)
    ground(coll, 20)
    sun = bpy.data.lights.new("Nova Sun", "SUN")
    sun.energy = 3.0
    sun_ob = bpy.data.objects.new("Nova Sun", sun)
    sun_ob.rotation_euler = (math.radians(50), 0, math.radians(30))
    coll.objects.link(sun_ob)
    return s


def build_empty(context, coll):
    s = new_system(context, coll, "Nova System", [
        dict(name="Particle", color_mode="BLACKBODY", temp0=2400, life_min=1, life_max=2, emit=20),
    ])
    emitter(coll, s, "Nova Emitter", "Particle", (0, 0, 0), shape="POINT", rate=500, speed=4, spread=0.4)
    return s


PRESETS = [
    ("FIREWORKS", "Fireworks Show", "Eleven shell types: peony, chrysanthemum, willow, palm, ring, crossette, "
                                    "crackle, strobe, heart, multicolor, colour change", build_fireworks),
    ("SPARKLER", "Sparkler", "Branching incandescent iron sparks", build_sparkler),
    ("CAMPFIRE", "Campfire", "Fluid fire with combustion, embers riding the flow, popping sparks", build_campfire),
    ("TORCH", "Torch", "Small licking flame on a handle", build_torch),
    ("EXPLOSION", "Explosion", "Expanding fireball with debris trailing smoke", build_explosion),
    ("GRINDER", "Grinder Sparks", "Directional spark spray that bounces and spatters", build_grinder),
    ("FOUNTAIN", "Spark Fountain", "Gerb fountain with glitter", build_fountain),
    ("MAGIC", "Magic Dust", "Twinkling trail behind a moving wand", build_magic_dust),
    ("EMBERS", "Drifting Embers", "Ambient embers carried by wind and heat", build_embers),
    ("VORTEX", "Energy Vortex", "Particles swirling around a vortex force", build_vortex),
    ("SNOW", "Snow", "Lit snowfall that settles", build_snow),
    ("EMPTY", "Empty System", "One type, one emitter: start from scratch", build_empty),
]


def build(context, key, setup_scene=False):
    _k, label, _d, fn = next(p for p in PRESETS if p[0] == key)
    coll = _collection(context, "Nova " + label)
    sysob = fn(context, coll)
    cursor = context.scene.cursor.location.copy()
    if cursor.length > 1e-6:
        _offset(coll, cursor)
    if setup_scene:
        setup_stage(context, coll, key, cursor)
    sim.free_cache(sysob)
    return sysob


STAGES = {
    "FIREWORKS": ((0, -150, 12), (0, 0, 62), 28, True),
    "SPARKLER": ((0.35, -0.85, 1.1), (0, 0, 0.98), 50, True),
    "CAMPFIRE": ((0, -3.2, 1.0), (0, 0, 0.7), 40, True),
    "TORCH": ((0, -2.0, 1.4), (0, 0, 1.3), 50, True),
    "EXPLOSION": ((0, -38, 5), (0, 0, 6.5), 35, "DUSK"),
    "GRINDER": ((2.5, -2.5, 1.0), (0, -0.6, 0.3), 35, True),
    "FOUNTAIN": ((0, -9, 2.0), (0, 0, 2.2), 35, True),
    "MAGIC": ((0, -4.5, 1.4), (0, 0, 1.2), 40, True),
    "EMBERS": ((0, -8, 2.0), (0, 0, 2.0), 35, True),
    "VORTEX": ((0, -8.5, 5.5), (0, 0, 0), 35, True),
    "SNOW": ((0, -14, 2.5), (0, 0, 2.5), 35, "DUSK"),
    "EMPTY": ((0, -10, 3), (0, 0, 2), 35, False),
}


def setup_stage(context, coll, key, offset):
    loc, target, lens, night = STAGES[key]
    camera(context, coll, Vector(loc) + offset, Vector(target) + offset, lens)
    if night == "DUSK":
        night_world(context, (0.06, 0.07, 0.1))
    elif night:
        night_world(context)
    render.setup_glow(context.scene)
