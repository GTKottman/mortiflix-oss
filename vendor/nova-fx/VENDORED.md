# Nova FX, vendored

Nova FX is included in Mortiflix as source (GPL-3.0-or-later, see LICENSE), copied from its original repository at
commit `7638ae6`. `mortiflix setup 3d` packs `addon/nova_fx` with the C core from `core/` into an extension and installs
it into the studio's own Blender profile; the add-on compiles the core for your CPU on first use.

**Nova FX is Mortiflix's own particle engine, and for now its core builds on Linux only** (gcc with OpenMP, usually
already installed). macOS and Windows builds aren't supported yet.

Change Nova here like any other part of Mortiflix; keep `core/` and `addon/` in step.
