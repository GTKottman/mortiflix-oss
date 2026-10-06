"""Nova FX: an optimization-first particle, fire and fireworks engine for Blender."""

import bpy

from . import ops, props, sim, ui


class NovaPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    threads: bpy.props.IntProperty(name="Threads", default=0, min=0, max=512,
                                   description="Simulation threads (0 = all cores)",
                                   update=lambda s, c: _apply_threads(s))

    def draw(self, context):
        from . import core
        layout = self.layout
        try:
            L = core.lib()
            layout.label(text=f"Core v{L.nv_version()} loaded · {L.nv_num_threads()} threads", icon="CHECKMARK")
        except RuntimeError as e:
            layout.label(text=str(e).splitlines()[0], icon="ERROR")
        layout.prop(self, "threads")
        layout.operator("nova.build_core", icon="TOOL_SETTINGS")


def _apply_threads(prefs):
    from . import core
    import os
    try:
        core.lib().nv_set_threads(prefs.threads or os.cpu_count() or 1)
    except RuntimeError:
        pass


def register():
    props.register()
    bpy.utils.register_class(NovaPreferences)
    for c in ops.CLASSES + ui.CLASSES:
        bpy.utils.register_class(c)
    bpy.types.VIEW3D_MT_add.append(ui.menu_add)
    sim.register()


def unregister():
    sim.unregister()
    bpy.types.VIEW3D_MT_add.remove(ui.menu_add)
    for c in reversed(ops.CLASSES + ui.CLASSES):
        bpy.utils.unregister_class(c)
    bpy.utils.unregister_class(NovaPreferences)
    props.unregister()
