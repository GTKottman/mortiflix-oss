import bpy

from . import presets, sim
from .ops import system_of
from .params import KIND_GROUPS, KIND_SPEC
from .props import FLUID_BOOL_SPEC, FLUID_INT_SPEC, FLUID_SPEC


class NOVA_UL_kinds(bpy.types.UIList):
    def draw_item(self, context, layout, data, item, icon, active_data, active_prop, index=0):
        icons = {"BLACKBODY": "LIGHT_SUN", "GRADIENT": "COLOR", "FIXED": "SHADING_SOLID"}
        layout.prop(item, "name", text="", emboss=False, icon=icons.get(item.color_mode, "DOT"))


class _Panel:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Nova FX"


def _sys(context):
    return system_of(context.object)


class NOVA_PT_main(_Panel, bpy.types.Panel):
    bl_label = "Nova FX"

    def draw(self, context):
        layout = self.layout
        layout.operator_menu_enum("nova.add_preset", "preset", text="Add Effect", icon="ADD")
        ob = context.object
        if ob is None:
            return
        sysob = _sys(context)
        if ob.nova.is_system:
            return
        col = layout.column(align=True)
        row = col.row(align=True)
        row.operator("nova.make", text="Emitter", icon="PARTICLES",
                     depress=ob.nova_emitter.enabled).role = "EMITTER"
        row.operator("nova.make", text="Collider", icon="MOD_PHYSICS",
                     depress=ob.nova_collider.enabled).role = "COLLIDER"
        row.operator("nova.make", text="Force", icon="FORCE_FORCE", depress=ob.nova_force.enabled).role = "FORCE"
        if ob.nova_emitter.enabled or ob.nova_collider.enabled or ob.nova_force.enabled:
            col.operator("nova.make", text="Clear Roles", icon="X").role = "CLEAR"
        if sysob and ob.nova_emitter.enabled:
            layout.operator("nova.select_system", text=f"System: {sysob.name}", icon="RESTRICT_SELECT_OFF")


class NOVA_PT_system(_Panel, bpy.types.Panel):
    bl_label = "Simulation"

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova.is_system

    def draw(self, context):
        layout = self.layout
        sysob = _sys(context)
        n = sysob.nova
        layout.use_property_split = True
        layout.use_property_decorate = False
        row = layout.row(align=True)
        row.scale_y = 1.4
        row.operator("nova.bake", icon="RENDER_ANIMATION")
        row.operator("nova.free_cache", text="", icon="TRASH")
        row.operator("nova.reset", text="", icon="FILE_REFRESH")
        layout.prop(n, "live")
        col = layout.column(align=True)
        col.prop(n, "frame_start", text="Frames")
        col.prop(n, "frame_end", text="End")
        layout.prop(n, "substeps")
        layout.prop(n, "time_scale")
        layout.prop(n, "max_particles")
        layout.prop(n, "seed")
        layout.prop(n, "cache_dir")
        st = sim.stats(sysob)
        cached = len(sim.cached_frames(sysob))
        box = layout.box()
        box.use_property_split = False
        c = box.column(align=True)
        c.label(text=f"{st.get('count', 0):,} particles · {cached} frames cached", icon="INFO")
        if st:
            c.label(text=f"Particles {st['particle_ms']:.1f} ms · frame {st['frame_ms']:.0f} ms")
            if st.get("device"):
                c.label(text=st["device"], icon="CHECKMARK" if st["device"].startswith("GPU:") else "ERROR")
            if st.get("cells"):
                c.label(text=f"Fluid {st['fluid_ms']:.0f} ms · {st['cg_iters']} pressure iterations")
                if str(st.get("device", "")).startswith("GPU:"):
                    c.label(text=f"{st['cells'] / 1e6:.2f}M cells on the GPU (dense)")
                else:
                    c.label(text=f"{st['active'] * 100:.0f}% of {st['cells'] / 1e6:.2f}M cells active (sparse)")


class NOVA_PT_types(_Panel, bpy.types.Panel):
    bl_label = "Particle Types"

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova.is_system

    def draw(self, context):
        layout = self.layout
        n = _sys(context).nova
        row = layout.row()
        row.template_list("NOVA_UL_kinds", "", n, "kinds", n, "kinds_index", rows=4)
        col = row.column(align=True)
        col.operator("nova.kind_add", text="", icon="ADD").duplicate = False
        col.operator("nova.kind_add", text="", icon="DUPLICATE").duplicate = True
        col.operator("nova.kind_remove", text="", icon="REMOVE")
        if not n.kinds:
            return
        k = n.kinds[min(n.kinds_index, len(n.kinds) - 1)]
        layout.use_property_split = True
        layout.use_property_decorate = False
        for gid, label, icon in KIND_GROUPS:
            header, body = layout.panel(f"nova_kind_{gid}", default_closed=gid not in {"life", "color"})
            header.label(text=label, icon=icon)
            if body is None:
                continue
            draw_kind_group(body, k, n, gid)


def draw_kind_group(layout, k, n, gid):
    cm = k.color_mode
    for name, t, _d, o in KIND_SPEC:
        if o["group"] != gid:
            continue
        if gid == "color":
            if name in {"temp0", "temp_var", "cool", "cool_rad"} and cm != "BLACKBODY":
                continue
            if name in {"color", "color_var", "hue_random"} and cm == "BLACKBODY":
                continue
            if name in {"color2", "color_curve"} and cm != "GRADIENT":
                continue
            if name == "twinkle_amt" and k.twinkle_freq <= 0:
                continue
        ref = {"death": "death_kind", "trail": "trail_kind", "split": "split_kind"}.get(gid)
        if ref and name != ref and not getattr(k, ref):
            continue
        if gid == "collide" and name != "collide" and k.collide == "NONE":
            continue
        if name in {"hit_count", "hit_speed"} and not k.hit_kind:
            continue
        label = name.replace("_", " ").title()
        if t == "K":
            layout.prop_search(k, name, n, "kinds", text=label.replace(" Kind", ""), icon="PARTICLES")
        else:
            layout.prop(k, name, text=label)


class NOVA_PT_forces(_Panel, bpy.types.Panel):
    bl_label = "World Forces"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova.is_system

    def draw(self, context):
        layout = self.layout
        n = _sys(context).nova
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.prop(n, "gravity")
        layout.prop(n, "wind")
        col = layout.column(align=True)
        col.prop(n, "turb_amp")
        col.prop(n, "turb_freq")
        col.prop(n, "turb_speed")
        col.prop(n, "turb_octaves")
        layout.prop(n, "t_ambient")


class NOVA_PT_fluid(_Panel, bpy.types.Panel):
    bl_label = "Fire & Smoke"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova.is_system

    def draw_header(self, context):
        self.layout.prop(_sys(context).nova.fluid, "enabled", text="")

    def draw(self, context):
        layout = self.layout
        fl = _sys(context).nova.fluid
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.active = fl.enabled
        layout.prop(fl, "domain")
        layout.prop(fl, "resolution")
        layout.prop(fl, "device", expand=True)
        if fl.domain:
            try:
                res, dx, _o = sim.fluid_layout(_sys(context))
                layout.label(text=f"{res[0]}×{res[1]}×{res[2]} cells · {dx * 100:.1f} cm voxels")
            except Exception:
                pass
        for gid, label in (("physics", "Gas"), ("fire", "Combustion"), ("solver", "Solver")):
            header, body = layout.panel(f"nova_fluid_{gid}", default_closed=gid == "solver")
            header.label(text=label)
            if body is None:
                continue
            for name, _d, _l, _kw, g, _desc in FLUID_SPEC:
                if g == gid:
                    body.prop(fl, name)
            if gid == "physics":
                body.prop(fl, "wind")
            if gid == "solver":
                for name, *_ in FLUID_INT_SPEC:
                    body.prop(fl, name)
                for name, *_ in FLUID_BOOL_SPEC:
                    body.prop(fl, name)
        header, body = layout.panel("nova_fluid_look", default_closed=False)
        header.label(text="Look")
        if body:
            for name in ("density_mult", "smoke_color", "flame_mult", "heat_mult", "temp_scale", "write_velocity"):
                body.prop(fl, name)


class NOVA_PT_display(_Panel, bpy.types.Panel):
    bl_label = "Display & Render"
    bl_options = {"DEFAULT_CLOSED"}

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova.is_system

    def draw(self, context):
        layout = self.layout
        n = _sys(context).nova
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.prop(n, "display")
        if n.display == "STREAKS":
            layout.prop(n, "streak_length")
        layout.prop(n, "shading")
        layout.prop(n, "size_mult")
        layout.prop(n, "emission_mult")
        layout.prop(n, "viewport_pct")
        layout.operator("nova.glow", icon="LIGHT_SUN")


class NOVA_PT_emitter(_Panel, bpy.types.Panel):
    bl_label = "Emitter"

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova_emitter.enabled

    def draw(self, context):
        layout = self.layout
        e = context.object.nova_emitter
        layout.use_property_split = True
        layout.use_property_decorate = False
        layout.prop(e, "system")
        if e.system:
            layout.prop_search(e, "kind", e.system.nova, "kinds", icon="PARTICLES")
        layout.prop(e, "shape")
        if e.shape == "SPHERE":
            layout.prop(e, "radius")
        if e.shape in {"SURFACE", "VERTS"}:
            layout.prop(e, "deforming")
        col = layout.column(align=True)
        col.prop(e, "rate")
        col.prop(e, "random_timing")
        col = layout.column(align=True)
        col.prop(e, "burst")
        col.prop(e, "burst_frame")
        col = layout.column(align=True)
        col.prop(e, "frame_start", text="Active From")
        col.prop(e, "frame_end", text="To")
        layout.prop(e, "direction")
        col = layout.column(align=True)
        col.prop(e, "speed")
        col.prop(e, "speed_var")
        if e.direction != "RANDOM":
            layout.prop(e, "spread")
        layout.prop(e, "inherit")
        layout.prop(e, "seed")
        header, body = layout.panel("nova_emitter_fluid", default_closed=not e.fl_enabled)
        header.prop(e, "fl_enabled", text="Fluid Source")
        if body:
            body.active = e.fl_enabled
            for name in ("fl_fuel", "fl_heat", "fl_density", "fl_speed", "fl_radius", "fl_noise", "fl_points"):
                body.prop(e, name)


class NOVA_PT_collider(_Panel, bpy.types.Panel):
    bl_label = "Collider"

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova_collider.enabled

    def draw(self, context):
        c = context.object.nova_collider
        self.layout.prop(c, "shape")
        if c.shape == "MESH":
            self.layout.prop(c, "sdf_res")
            self.layout.prop(c, "deforming")


class NOVA_PT_force(_Panel, bpy.types.Panel):
    bl_label = "Force"

    @classmethod
    def poll(cls, context):
        ob = context.object
        return ob is not None and ob.nova_force.enabled

    def draw(self, context):
        layout = self.layout
        f = context.object.nova_force
        layout.use_property_split = True
        layout.prop(f, "type")
        layout.prop(f, "strength")
        layout.prop(f, "radius")
        layout.prop(f, "falloff")
        if f.type == "TURBULENCE":
            layout.prop(f, "freq")


class NOVA_MT_add(bpy.types.Menu):
    bl_label = "Nova FX"
    bl_idname = "NOVA_MT_add"

    def draw(self, context):
        for key, label, _d, _f in presets.PRESETS:
            op = self.layout.operator("nova.add_preset", text=label)
            op.preset = key


def menu_add(self, context):
    self.layout.menu("NOVA_MT_add", icon="PARTICLES")


CLASSES = (NOVA_UL_kinds, NOVA_PT_main, NOVA_PT_system, NOVA_PT_types, NOVA_PT_forces, NOVA_PT_fluid,
           NOVA_PT_display, NOVA_PT_emitter, NOVA_PT_collider, NOVA_PT_force, NOVA_MT_add)
