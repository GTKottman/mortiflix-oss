"""Materials, streak display (Geometry Nodes) and glow for Nova systems."""

import bpy

PMAT = "Nova Particles"
VMAT = "Nova Fire"
DISPLAY_GROUP = "Nova Display"


def _node(nt, t, loc, **props):
    n = nt.nodes.new(t)
    n.location = loc
    for k, v in props.items():
        setattr(n, k, v)
    return n


def _first(nt, t):
    return next((n for n in nt.nodes if n.bl_idname == t), None)


# ------------------------------------------------------------------ particle material

def particle_material(sysob):
    name = f"{PMAT} · {sysob.name}"
    mat = bpy.data.materials.get(name)
    if mat and mat.node_tree and mat.get("nova_v") == 2:
        return mat
    mat = mat or bpy.data.materials.new(name)
    mat["nova_v"] = 2
    if not mat.node_tree:
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = _node(nt, "ShaderNodeOutputMaterial", (900, 0))
    cd = _node(nt, "ShaderNodeAttribute", (-500, 150), attribute_name="Cd", attribute_type="GEOMETRY", label="Cd")
    em = _node(nt, "ShaderNodeAttribute", (-500, -100), attribute_name="emit", attribute_type="GEOMETRY",
               label="emit")
    mul = _node(nt, "ShaderNodeMath", (-250, -100), operation="MULTIPLY", label="Brightness")
    mul.name = "nova_brightness"
    emis = _node(nt, "ShaderNodeEmission", (100, 150))
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled", (100, -200))
    mix = _node(nt, "ShaderNodeMixShader", (600, 0))
    mix.name = "nova_lit"
    L = nt.links
    L.new(em.outputs["Fac"], mul.inputs[0])
    L.new(cd.outputs["Color"], emis.inputs["Color"])
    L.new(mul.outputs[0], emis.inputs["Strength"])
    L.new(cd.outputs["Color"], bsdf.inputs["Base Color"])
    L.new(cd.outputs["Color"], bsdf.inputs["Emission Color"])
    L.new(emis.outputs[0], mix.inputs[1])
    L.new(bsdf.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs["Surface"])
    # glowing pixels are mostly light, not surface: keep them cheap in Cycles
    return mat


# ------------------------------------------------------------------ volume material

def volume_material(sysob):
    name = f"{VMAT} · {sysob.name}"
    mat = bpy.data.materials.get(name)
    if mat and mat.node_tree and mat.get("nova_v") == 4:
        return mat
    mat = mat or bpy.data.materials.new(name)
    mat["nova_v"] = 4
    if not mat.node_tree:
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = _node(nt, "ShaderNodeOutputMaterial", (900, 0))
    vol = _node(nt, "ShaderNodeVolumePrincipled", (550, 0))
    vol.name = "nova_volume"
    heat = _node(nt, "ShaderNodeAttribute", (-700, -150), attribute_name="heat", label="heat")
    flame = _node(nt, "ShaderNodeAttribute", (-700, -400), attribute_name="flame", label="flame")
    kel = _node(nt, "ShaderNodeMath", (-450, -50), operation="MULTIPLY_ADD", label="Kelvin")
    kel.name = "nova_kelvin"
    kel.inputs[2].default_value = 300.0
    bb = _node(nt, "ShaderNodeBlackbody", (-250, -50))
    # glowing gas: nothing below a threshold, then a steep (T^3) rise, like hot gas really looks
    sub = _node(nt, "ShaderNodeMath", (-600, -250), operation="SUBTRACT")
    sub.inputs[1].default_value = 0.25
    pos = _node(nt, "ShaderNodeMath", (-520, -250), operation="MAXIMUM")
    pos.inputs[1].default_value = 0.0
    sq = _node(nt, "ShaderNodeMath", (-450, -250), operation="POWER")
    sq.inputs[1].default_value = 3.0
    fm = _node(nt, "ShaderNodeMath", (-250, -420), operation="MULTIPLY_ADD", label="Flame")
    fm.name = "nova_flame"  # flame * flame_mult + heat_mult
    fm.inputs[2].default_value = 1.0
    hm = _node(nt, "ShaderNodeMath", (0, -300), operation="MULTIPLY", label="Glow")
    L = nt.links
    L.new(heat.outputs["Fac"], kel.inputs[0])
    L.new(kel.outputs[0], bb.inputs[0])
    L.new(bb.outputs[0], vol.inputs["Emission Color"])
    L.new(heat.outputs["Fac"], sub.inputs[0])
    L.new(sub.outputs[0], pos.inputs[0])
    L.new(pos.outputs[0], sq.inputs[0])
    L.new(sq.outputs[0], hm.inputs[0])
    L.new(flame.outputs["Fac"], fm.inputs[0])
    L.new(fm.outputs[0], hm.inputs[1])
    L.new(hm.outputs[0], vol.inputs["Emission Strength"])
    L.new(vol.outputs[0], out.inputs["Volume"])
    vol.inputs["Density Attribute"].default_value = "density"
    vol.inputs["Temperature Attribute"].default_value = ""
    vol.inputs["Blackbody Intensity"].default_value = 0.0
    return mat


def ensure_volume_material(sysob):
    vob = sysob.nova.fluid.volume
    if not vob:
        return
    mat = volume_material(sysob)
    if not vob.data.materials:
        vob.data.materials.append(mat)
    elif vob.data.materials[0] != mat:
        vob.data.materials[0] = mat
    sync_materials(sysob)


# ------------------------------------------------------------------ display (GN)

def display_group():
    """Streaks for a companion Curves object: read the system's points (Object Info), give each a
    2-point curve trailing behind its motion. Cycles only draws GN curves on Curves objects, and
    curves are ~18x cheaper to render than mesh tubes (1M streaks: 1.4 s vs 25 s)."""
    ng = bpy.data.node_groups.get(DISPLAY_GROUP)
    if ng and ng.get("nova_v") == 6:
        return ng
    if ng is None:
        ng = bpy.data.node_groups.new(DISPLAY_GROUP, "GeometryNodeTree")
    ng["nova_v"] = 6
    ng.nodes.clear()
    ng.interface.clear()
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("System", in_out="INPUT", socket_type="NodeSocketObject")
    s = ng.interface.new_socket("Length", in_out="INPUT", socket_type="NodeSocketFloat")
    s.default_value = 0.03
    s.min_value = 0.0
    ng.interface.new_socket("Material", in_out="INPUT", socket_type="NodeSocketMaterial")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gi = _node(ng, "NodeGroupInput", (-1100, 0))
    go = _node(ng, "NodeGroupOutput", (1100, 0))
    info = _node(ng, "GeometryNodeObjectInfo", (-900, 200), transform_space="RELATIVE")
    vel = _node(ng, "GeometryNodeInputNamedAttribute", (-700, -250), data_type="FLOAT_VECTOR")
    vel.inputs["Name"].default_value = "velocity"
    rad = _node(ng, "GeometryNodeInputNamedAttribute", (-700, -450), data_type="FLOAT")
    rad.inputs["Name"].default_value = "radius"
    length = _node(ng, "ShaderNodeVectorMath", (-500, -250), operation="LENGTH")
    lmul = _node(ng, "ShaderNodeMath", (-300, -250), operation="MULTIPLY")
    r2 = _node(ng, "ShaderNodeMath", (-300, -450), operation="MULTIPLY")
    r2.inputs[1].default_value = 2.0
    lmax = _node(ng, "ShaderNodeMath", (-100, -300), operation="MAXIMUM")
    scale = _node(ng, "ShaderNodeCombineXYZ", (100, -350))
    scale.inputs["X"].default_value = 1.0
    scale.inputs["Y"].default_value = 1.0
    align = _node(ng, "FunctionNodeAlignRotationToVector", (100, -150))
    align.axis = "Z"
    # "radius" is a built-in name that realize does not carry onto curve points: keep a private copy
    keep = _node(ng, "GeometryNodeStoreNamedAttribute", (-500, 200), data_type="FLOAT", domain="POINT")
    keep.inputs["Name"].default_value = "nv_radius"
    line = _node(ng, "GeometryNodeCurvePrimitiveLine", (-100, 150))
    line.inputs["Start"].default_value = (0, 0, 0)
    line.inputs["End"].default_value = (0, 0, -1)
    inst = _node(ng, "GeometryNodeInstanceOnPoints", (300, 50))
    real = _node(ng, "GeometryNodeRealizeInstances", (500, 50))
    rad2 = _node(ng, "GeometryNodeInputNamedAttribute", (500, -250), data_type="FLOAT")
    rad2.inputs["Name"].default_value = "nv_radius"
    setrad = _node(ng, "GeometryNodeSetCurveRadius", (700, 50))
    setmat = _node(ng, "GeometryNodeSetMaterial", (900, 50))
    L = ng.links
    L.new(gi.outputs["System"], info.inputs["Object"])
    L.new(info.outputs["Geometry"], keep.inputs["Geometry"])
    L.new(rad.outputs["Attribute"], keep.inputs["Value"])
    L.new(vel.outputs["Attribute"], length.inputs[0])
    L.new(length.outputs["Value"], lmul.inputs[0])
    L.new(gi.outputs["Length"], lmul.inputs[1])
    L.new(rad.outputs["Attribute"], r2.inputs[0])
    L.new(lmul.outputs[0], lmax.inputs[0])
    L.new(r2.outputs[0], lmax.inputs[1])
    L.new(lmax.outputs[0], scale.inputs["Z"])
    L.new(vel.outputs["Attribute"], align.inputs["Vector"])
    L.new(keep.outputs["Geometry"], inst.inputs["Points"])
    L.new(line.outputs[0], inst.inputs["Instance"])
    L.new(align.outputs["Rotation"], inst.inputs["Rotation"])
    L.new(scale.outputs["Vector"], inst.inputs["Scale"])
    L.new(inst.outputs["Instances"], real.inputs["Geometry"])
    L.new(real.outputs["Geometry"], setrad.inputs["Curve"])
    L.new(rad2.outputs["Attribute"], setrad.inputs["Radius"])
    L.new(setrad.outputs[0], setmat.inputs["Geometry"])
    L.new(gi.outputs["Material"], setmat.inputs["Material"])
    L.new(setmat.outputs["Geometry"], go.inputs["Geometry"])
    return ng


def _mod_input(mod, name, value):
    ng = mod.node_group
    item = next((i for i in ng.interface.items_tree if getattr(i, "in_out", "") == "INPUT" and i.name == name), None)
    if item is None:
        return
    props = getattr(mod, "properties", None)  # Blender 5.2+: typed interface
    if props is not None and hasattr(props.inputs, item.identifier):
        getattr(props.inputs, item.identifier).value = value
    else:
        mod[item.identifier] = value


def streak_object(sysob, create=True):
    name = sysob.name + " Streaks"
    ob = bpy.data.objects.get(name)
    if ob is not None and ob.type == "CURVES":
        return ob
    if not create:
        return None
    ob = bpy.data.objects.new(name, bpy.data.hair_curves.new(name))
    for coll in sysob.users_collection:
        coll.objects.link(ob)
    ob.hide_select = True
    return ob


def sync_display(sysob):
    if sysob.type != "POINTCLOUD":
        return
    n = sysob.nova
    mat = particle_material(sysob)
    if not sysob.data.materials:
        sysob.data.materials.append(mat)
    old = sysob.modifiers.get("Nova Display")  # pre-1.1 streaks lived on the point cloud
    if old:
        sysob.modifiers.remove(old)
    streaks = n.display == "STREAKS"
    sob = streak_object(sysob, create=streaks)
    if sob is not None:
        mod = sob.modifiers.get("Nova Display") or sob.modifiers.new("Nova Display", "NODES")
        if mod.node_group is None or mod.node_group.get("nova_v") != 6:
            mod.node_group = display_group()
        _mod_input(mod, "System", sysob)
        _mod_input(mod, "Length", float(n.streak_length))
        _mod_input(mod, "Material", mat)
        sob.hide_render = not streaks
        sob.hide_viewport = not streaks
        sob.matrix_world = sysob.matrix_world.copy()
        if not sob.data.materials:
            sob.data.materials.append(mat)
        sob.update_tag()
    # the points stay selectable (panels live on them) but show as a box while streaks draw
    sysob.hide_render = streaks
    sysob.display_type = "BOUNDS" if streaks else "TEXTURED"
    sysob.update_tag()


def sync_materials(sysob):
    n = sysob.nova
    mat = bpy.data.materials.get(f"{PMAT} · {sysob.name}")
    if mat and mat.node_tree:
        b = mat.node_tree.nodes.get("nova_brightness")
        if b:
            b.inputs[1].default_value = n.emission_mult
        m = mat.node_tree.nodes.get("nova_lit")
        if m:
            m.inputs[0].default_value = 1.0 if n.shading == "LIT" else 0.0
    vmat = bpy.data.materials.get(f"{VMAT} · {sysob.name}")
    if vmat and vmat.node_tree:
        fl = n.fluid
        nt = vmat.node_tree
        v = nt.nodes.get("nova_volume")
        if v:
            v.inputs["Density"].default_value = fl.density_mult
            v.inputs["Color"].default_value = (*fl.smoke_color, 1.0)
        k = nt.nodes.get("nova_kelvin")
        if k:
            k.inputs[1].default_value = fl.temp_scale
        f = nt.nodes.get("nova_flame")
        if f:
            f.inputs[1].default_value = fl.flame_mult
            f.inputs[2].default_value = fl.heat_mult


# ------------------------------------------------------------------ glow

def setup_glow(scene, strength=0.3, size=0.45, threshold=1.5):
    """Bloom in the compositor so bright sparks bleed light like a real lens."""
    ng = bpy.data.node_groups.get("Nova Glow")
    if ng is None:
        ng = bpy.data.node_groups.new("Nova Glow", "CompositorNodeTree")
        ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        rl = _node(ng, "CompositorNodeRLayers", (-400, 0))
        gl = _node(ng, "CompositorNodeGlare", (0, 0))
        gl.name = "nova_glare"
        out = _node(ng, "NodeGroupOutput", (400, 0))
        ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
        ng.links.new(gl.outputs["Image"], out.inputs[0])
    gl = ng.nodes.get("nova_glare")
    if gl:
        sock = gl.inputs.get("Type")
        if sock is not None:
            try:
                sock.default_value = "Bloom"
            except TypeError:
                pass
        for key, val in (("Threshold", threshold), ("Strength", strength), ("Size", size)):
            s = gl.inputs.get(key)
            if s is not None:
                try:
                    s.default_value = val
                except TypeError:
                    pass
    scene.compositing_node_group = ng
    return ng
