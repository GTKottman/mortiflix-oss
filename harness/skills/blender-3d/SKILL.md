---
name: blender-3d
description: 3D work in the studio's own Blender with its toolkits: MoBlend (MoGraph cloners, effectors, fields, MoText, fracture), Nova FX (particles, fire, sparks, fireworks), Camera (framing, shot presets, moves, shake, cuts, contact sheets), Animate (easing, springs, paths), Math (LaTeX and exact math) and Circuits. Use for any 3D scene, product shot, logo in 3D, particle effect or camera move rendered in Blender.
---

# Blender 3D

The owner set up a Blender for this studio with its own profile and toolkits. Use it, not a system Blender, and never
install add-ons yourself.

```
"$MFX_BLENDER" -b 3d/scene.blend --python 3d/shot.py            # BLENDER_USER_RESOURCES is already set: the studio profile
mfx render --label "3d shot 2" -- "$MFX_BLENDER" -b 3d/scene.blend -o //../out/3d/f_#### -a   # renders queue like any heavy job
```

## Calling the toolkits

Inside a script Blender runs, `mfx3d` calls any toolkit command directly (no server, no MCP):

```python
import sys, os; sys.path.insert(0, os.environ["MFX3D"])
import mfx3d
print(mfx3d.commands("camera"))                                   # what a toolkit can do
mfx3d.call("camera", "apply_shot_preset", {"subject": "Product", "shot_size": "medium", "angle": "low"})
mfx3d.call("mograph", "create_cloner", {"type": "grid"})
nova = mfx3d.particles()                                          # Nova FX: presets.new_system / emitter / col
```

| Kit | Toolkit | Read first |
|---|---|---|
| `camera` | Camera | the **blender-camera-director** skill (its tool names are these commands), `toolkits/camera.md` |
| `animate` | Animate | the **blender-animate** skill, `toolkits/animate.md` |
| `math` | Math | the **blender-math** skill, `toolkits/math.md` |
| `circuits` | Circuits | the **circuit-explainer-video** skill, `toolkits/circuits.md` |
| `mograph` | MoBlend | `toolkits/mograph.md` (its MCP tool names are these commands) |
| `particles` | Nova FX | `toolkits/particles.md`; step the simulation with `scene.frame_set` from the system's start frame |

Those skills were written for MCP clients: wherever one says "call `animate_orbit`", call
`mfx3d.call("camera", "animate_orbit", {...})` in your script. A wrong parameter name raises with the list of valid
ones: read it, don't guess twice.

## Working method

1. **Build the scene in scripts** (`3d/*.py`), not by hand: re-runnable, reviewable, and the next session can change
   them. Save the `.blend` after each script so a render never depends on a script having run.
2. **Look at what you made.** The camera kit's `render_preview` and `render_contact_sheet` write images: view them
   before you submit anything. `analyze_framing` reports headroom and coverage in numbers; check them against the
   frame's text-safe area.
3. **Motion that reads:** ease every move (Animate's springs and curves), keep cameras level unless the shot is a
   Dutch angle on purpose, and let particles settle before a cut.
4. **Renders go through `mfx render`** (they queue behind other heavy work). Eevee for previews and style frames,
   Cycles only when the look needs it and the owner's machine can afford it. Check the frame sheet like any motion.
5. **Nova FX** (Linux only for now) compiled its core for this CPU when it was installed. If it says the core isn't
   built, don't work around it: build the effect another way, or `mfx needs-you` if the brief depends on it.

The owner can open this same Blender with `mortiflix blender` (it has Camera Flight, for flying the camera by hand):
if a shot needs a hand-flown move, ask for a take instead of faking one.
