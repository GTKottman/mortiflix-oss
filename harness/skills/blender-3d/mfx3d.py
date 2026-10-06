"""Call the studio's 3D toolkits from a script running inside Blender (blender -b scene.blend --python shot.py).

    import sys, os; sys.path.insert(0, os.environ["MFX3D"])
    import mfx3d
    mfx3d.call("camera", "apply_shot_preset", {"target": "Product", "shot": "medium", "angle": "low"})
    mfx3d.call("mograph", "create_cloner", {"mode": "grid", "count": [5, 5, 1]})
    nova = mfx3d.particles()          # Nova FX's presets module: nova.new_system(...), nova.emitter(...)
    print(mfx3d.commands("animate"))   # every command a toolkit has

Each command is the same as the toolkit's MCP tool of the same name (their own skills describe them), run directly on
Blender's main thread: no server, no socket. Results come back as Python values; errors raise with the toolkit's own
message (they suggest the fix).
"""
import importlib

import bpy

KITS = {
    "mograph": "moblend",
    "particles": "nova_fx",
    "camera": "blender_cam_mcp",
    "animate": "blender_animate",
    "math": "blender_math_bridge",
    "circuits": "circuit_lab",
}


def _module(kit, sub=None):
    if kit not in KITS:
        raise ValueError(f"unknown toolkit {kit!r}: {', '.join(KITS)}")
    name = f"bl_ext.user_default.{KITS[kit]}"
    if name not in bpy.context.preferences.addons:
        import addon_utils
        addon_utils.enable(name, default_set=False)
    return importlib.import_module(f"{name}.{sub}" if sub else name)


def call(kit, command, params=None):
    params = params or {}
    if kit == "math":
        reply = _module("math").dispatch({"type": command, "params": params})
        if reply.get("status") != "ok":
            raise RuntimeError(reply.get("message", "math command failed"))
        return reply.get("result")
    if kit == "particles":
        raise ValueError("Nova FX has no command table: use mfx3d.particles() (its presets module), see its README")
    return _module(kit, "commands").dispatch(command, params)


def commands(kit):
    if kit == "math":
        return sorted(_module("math").COMMANDS)
    if kit == "particles":
        return sorted(n for n in dir(particles()) if not n.startswith("_"))
    mod = _module(kit, "commands")
    table = getattr(mod, "COMMANDS", None) or getattr(mod, "_COMMANDS", {})
    return sorted(table)


def particles():
    return _module("particles", "presets")
