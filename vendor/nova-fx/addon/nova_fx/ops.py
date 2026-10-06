import os
import time

import bpy
from bpy.props import BoolProperty, EnumProperty, IntProperty, StringProperty

from . import core, presets, render, sim


def system_of(ob):
    if ob is None:
        return None
    if ob.nova.is_system:
        return ob
    if ob.nova_emitter.enabled and ob.nova_emitter.system:
        return ob.nova_emitter.system
    return None


def _system_items(self, context):
    items = [(ob.name, ob.name, "") for ob in sim.systems(context.scene)]
    return items or [("", "No systems", "")]


class NOVA_OT_add_preset(bpy.types.Operator):
    """Add a ready-made Nova FX effect at the 3D cursor"""
    bl_idname = "nova.add_preset"
    bl_label = "Add Nova Effect"
    bl_options = {"REGISTER", "UNDO"}

    preset: EnumProperty(name="Effect", items=[(k, l, d) for k, l, d, _f in presets.PRESETS])
    setup_scene: BoolProperty(name="Camera, World & Glow", default=False,
                              description="Also add a framed camera, a night sky and compositor bloom")

    def execute(self, context):
        try:
            core.lib()
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        sysob = presets.build(context, self.preset, self.setup_scene)
        for ob in context.selected_objects:
            ob.select_set(False)
        sysob.select_set(True)
        context.view_layer.objects.active = sysob
        context.scene.frame_set(sysob.nova.frame_start)
        self.report({"INFO"}, f"{sysob.name}: press Play to preview, or Bake")
        return {"FINISHED"}


class NOVA_OT_bake(bpy.types.Operator):
    """Simulate every frame and store it on disk (Esc stops)"""
    bl_idname = "nova.bake"
    bl_label = "Bake"

    _timer = None

    @classmethod
    def poll(cls, context):
        return system_of(context.object) is not None and not sim.STATE["baking"]

    def invoke(self, context, event):
        self.sysob = system_of(context.object)
        try:
            core.lib()
        except RuntimeError as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}
        sim.free_cache(self.sysob)
        n = self.sysob.nova
        self.frame = n.frame_start
        self.t0 = time.perf_counter()
        sim.STATE["baking"] = True
        wm = context.window_manager
        wm.progress_begin(n.frame_start, n.frame_end)
        self._timer = wm.event_timer_add(0.001, window=context.window)
        wm.modal_handler_add(self)
        return {"RUNNING_MODAL"}

    def _finish(self, context, cancelled=False):
        wm = context.window_manager
        wm.event_timer_remove(self._timer)
        wm.progress_end()
        sim.STATE["baking"] = False
        sysob = self.sysob
        sim.wait_vdb(sysob)
        if sysob.nova.fluid.enabled and sysob.nova.fluid.domain:
            sim.ensure_volume_object(context.scene, sysob)
            sim.refresh_volume(sysob)
        context.workspace.status_text_set(None)
        context.scene.frame_set(sysob.nova.frame_start)
        dt = time.perf_counter() - self.t0
        frames = self.frame - sysob.nova.frame_start
        msg = f"{sysob.name}: {'stopped after' if cancelled else 'baked'} {frames} frames in {dt:.1f}s"
        self.report({"WARNING" if cancelled else "INFO"}, msg)

    def modal(self, context, event):
        if event.type == "ESC":
            self._finish(context, cancelled=True)
            return {"CANCELLED"}
        if event.type != "TIMER":
            return {"PASS_THROUGH"}
        sysob, scene = self.sysob, context.scene
        n = sysob.nova
        if self.frame > n.frame_end:
            self._finish(context)
            return {"FINISHED"}
        scene.frame_set(self.frame)
        try:
            sim.step(scene, sysob, self.frame, context.evaluated_depsgraph_get())
        except Exception as e:
            self._finish(context, cancelled=True)
            self.report({"ERROR"}, f"Nova FX: {e}")
            return {"CANCELLED"}
        sim.load_frame(sysob, self.frame)
        st = sim.stats(sysob)
        context.window_manager.progress_update(self.frame)
        context.workspace.status_text_set(
            f"Nova FX baking {sysob.name}: frame {self.frame}/{n.frame_end}  ·  {st.get('count', 0):,} particles  ·  "
            f"{st.get('frame_ms', 0):.0f} ms/frame  ·  Esc to stop")
        self.frame += 1
        return {"RUNNING_MODAL"}


class NOVA_OT_free_cache(bpy.types.Operator):
    """Delete this system's baked frames"""
    bl_idname = "nova.free_cache"
    bl_label = "Free Cache"

    @classmethod
    def poll(cls, context):
        return system_of(context.object) is not None

    def execute(self, context):
        sysob = system_of(context.object)
        sim.free_cache(sysob)
        sim.load_frame(sysob, context.scene.frame_current)
        return {"FINISHED"}


class NOVA_OT_reset(bpy.types.Operator):
    """Jump to the start frame and restart the live simulation"""
    bl_idname = "nova.reset"
    bl_label = "Restart"

    def execute(self, context):
        sysob = system_of(context.object)
        if sysob:
            sim._RT.pop(sysob.name, None)
            context.scene.frame_set(sysob.nova.frame_start)
        return {"FINISHED"}


class NOVA_OT_kind_add(bpy.types.Operator):
    """Add a particle type"""
    bl_idname = "nova.kind_add"
    bl_label = "Add Type"
    bl_options = {"UNDO"}
    duplicate: BoolProperty(default=False)

    def execute(self, context):
        n = system_of(context.object).nova
        src = n.kinds[n.kinds_index] if self.duplicate and n.kinds else None
        k = n.kinds.add()
        base = (src.name if src else "Type")
        names = {x.name for x in n.kinds}
        name, i = base, 1
        while name in names:
            i += 1
            name = f"{base} {i}"
        if src:
            for p in src.bl_rna.properties:
                if p.identifier not in {"rna_type", "name"} and not p.is_readonly:
                    setattr(k, p.identifier, getattr(src, p.identifier))
        k.name = name
        k["_prev_name"] = name
        n.kinds_index = len(n.kinds) - 1
        return {"FINISHED"}


class NOVA_OT_kind_remove(bpy.types.Operator):
    """Remove the selected particle type"""
    bl_idname = "nova.kind_remove"
    bl_label = "Remove Type"
    bl_options = {"UNDO"}

    def execute(self, context):
        n = system_of(context.object).nova
        if n.kinds:
            n.kinds.remove(n.kinds_index)
            n.kinds_index = max(0, min(n.kinds_index, len(n.kinds) - 1))
        return {"FINISHED"}


class NOVA_OT_make(bpy.types.Operator):
    """Turn the selected objects into Nova emitters, colliders or forces"""
    bl_idname = "nova.make"
    bl_label = "Make Nova Object"
    bl_options = {"REGISTER", "UNDO"}

    role: EnumProperty(items=[("EMITTER", "Emitter", ""), ("COLLIDER", "Collider", ""), ("FORCE", "Force", ""),
                              ("CLEAR", "Clear", "")])
    system: EnumProperty(name="System", items=_system_items)

    def invoke(self, context, event):
        if self.role == "EMITTER" and len(sim.systems(context.scene)) > 1:
            return context.window_manager.invoke_props_dialog(self)
        return self.execute(context)

    def execute(self, context):
        systems = sim.systems(context.scene)
        if self.role == "EMITTER" and not systems:
            self.report({"ERROR"}, "Add a Nova system first (Add Effect → Empty System)")
            return {"CANCELLED"}
        sysob = bpy.data.objects.get(self.system) if self.system else None
        sysob = sysob or (systems[0] if systems else None)
        for ob in context.selected_objects or [context.object]:
            if ob is None or ob.nova.is_system:
                continue
            if self.role == "EMITTER":
                e = ob.nova_emitter
                e.enabled, e.system = True, sysob
                if not e.kind and sysob.nova.kinds:
                    e.kind = sysob.nova.kinds[0].name
                e.shape = "SURFACE" if ob.type == "MESH" else "POINT"
                e.frame_start, e.frame_end = sysob.nova.frame_start, sysob.nova.frame_end
            elif self.role == "COLLIDER":
                ob.nova_collider.enabled = True
                ob.nova_collider.shape = "PLANE" if ob.type == "MESH" and max(ob.dimensions) > 0 and \
                    min(ob.dimensions) < 1e-4 else "BOX"
            elif self.role == "FORCE":
                ob.nova_force.enabled = True
            else:
                ob.nova_emitter.enabled = False
                ob.nova_collider.enabled = False
                ob.nova_force.enabled = False
        return {"FINISHED"}


class NOVA_OT_select_system(bpy.types.Operator):
    """Select this emitter's system"""
    bl_idname = "nova.select_system"
    bl_label = "Select System"

    def execute(self, context):
        sysob = system_of(context.object)
        if sysob:
            for ob in context.selected_objects:
                ob.select_set(False)
            sysob.hide_set(False)
            sysob.select_set(True)
            context.view_layer.objects.active = sysob
        return {"FINISHED"}


class NOVA_OT_glow(bpy.types.Operator):
    """Add bloom in the compositor so bright sparks bleed light"""
    bl_idname = "nova.glow"
    bl_label = "Add Glow"

    def execute(self, context):
        render.setup_glow(context.scene)
        return {"FINISHED"}


class NOVA_OT_build_core(bpy.types.Operator):
    """Recompile the simulation core for this CPU"""
    bl_idname = "nova.build_core"
    bl_label = "Rebuild Core"

    def execute(self, context):
        ok, log = core.build(force=True)
        self.report({"INFO"} if ok else {"ERROR"}, "Core rebuilt (restart Blender to load it)" if ok else log[-500:])
        return {"FINISHED"} if ok else {"CANCELLED"}


CLASSES = (NOVA_OT_add_preset, NOVA_OT_bake, NOVA_OT_free_cache, NOVA_OT_reset, NOVA_OT_kind_add,
           NOVA_OT_kind_remove, NOVA_OT_make, NOVA_OT_select_system, NOVA_OT_glow, NOVA_OT_build_core)
