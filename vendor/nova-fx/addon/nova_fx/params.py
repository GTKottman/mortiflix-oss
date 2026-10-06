"""UI metadata for every particle-type parameter. Names match the C core (see KIND_PARAMS in
nova_core.c) except colours, enums, booleans and type references, which are mapped in pack_kind()."""

import math

import numpy as np

COLOR_MODES = [
    ("FIXED", "Fixed", "One colour for the whole life"),
    ("GRADIENT", "Gradient", "Blend from Color to End Color over the life"),
    ("BLACKBODY", "Incandescent", "Glowing hot matter: colour and brightness from temperature (Planck, T^4)"),
]
PATTERNS = [
    ("SPHERE", "Sphere", "Evenly spaced burst (peony, chrysanthemum)"),
    ("RANDOM", "Random", "Filled random ball (explosion debris, crackle)"),
    ("RING", "Ring", "Flat ring with a random tilt"),
    ("PALM", "Palm", "A few heavy arms over the top half"),
    ("CROSS", "Crossette", "Four-way cross across the direction of travel"),
    ("HEART", "Heart", "Heart shape in a vertical plane"),
    ("CONE", "Cone", "Spray around the direction of travel"),
    ("HEMI", "Upper Half", "Random over the upper hemisphere (fountains, splashes)"),
]
COLLIDE = [
    ("NONE", "Pass Through", "Ignore colliders"),
    ("BOUNCE", "Bounce", "Bounce off colliders"),
    ("DIE", "Die", "Die on contact"),
    ("STICK", "Stick", "Stop and slide on contact"),
]

# (name, type, default, options). Types: F float, I int, B bool, E enum, K particle-type reference,
# C colour (maps to three C params). "group" decides the UI box.
KIND_SPEC = [
    ("life_min", "F", 1.0, dict(min=0.001, soft_max=20, unit="TIME_ABSOLUTE", group="life", desc="Shortest lifetime")),
    ("life_max", "F", 2.0, dict(min=0.001, soft_max=20, unit="TIME_ABSOLUTE", group="life", desc="Longest lifetime")),
    ("size_start", "F", 0.02, dict(min=0, soft_max=1, unit="LENGTH", group="life", desc="Radius at birth")),
    ("size_end", "F", 0.01, dict(min=0, soft_max=1, unit="LENGTH", group="life", desc="Radius at death")),
    ("size_var", "F", 0.2, dict(min=0, max=1, group="life", desc="Random size variation")),
    ("size_curve", "F", 1.0, dict(min=0.05, soft_max=8, group="life", desc="Shape of the size change (1 linear, >1 late, <1 early)")),

    ("gravity", "F", 1.0, dict(soft_min=-2, soft_max=2, group="motion", desc="Gravity multiplier")),
    ("drag_lin", "F", 0.0, dict(min=0, soft_max=10, group="motion", desc="Linear air drag (1/s). Wind acts through drag")),
    ("drag_quad", "F", 0.0, dict(min=0, soft_max=5, group="motion", desc="Quadratic air drag: fast things slow down sharply (tiny hot sparks)")),
    ("buoyancy", "F", 0.0, dict(soft_min=-10, soft_max=10, group="motion", desc="Upward push per 1000 K above ambient (hot embers rise)")),
    ("turb", "F", 1.0, dict(soft_min=0, soft_max=5, group="motion", desc="How strongly the system turbulence moves this type")),
    ("wind", "F", 1.0, dict(soft_min=0, soft_max=2, group="motion", desc="How much the system wind applies")),
    ("force", "F", 1.0, dict(soft_min=0, soft_max=5, group="motion", desc="How strongly force objects act on this type")),
    ("fluid_drag", "F", 0.0, dict(min=0, soft_max=20, group="motion", desc="Ride the fluid: pull toward the fluid velocity (1/s)")),

    ("color_mode", "E", "FIXED", dict(items=COLOR_MODES, group="color", desc="How colour is decided")),
    ("color", "C", (1.0, 0.6, 0.2), dict(group="color", desc="Colour (start colour for Gradient)")),
    ("color2", "C", (1.0, 0.2, 0.05), dict(group="color", desc="End colour for Gradient")),
    ("color_var", "F", 0.1, dict(min=0, max=1, group="color", desc="Random hue and brightness variation")),
    ("color_curve", "F", 1.0, dict(min=0.05, soft_max=8, group="color", desc="Shape of the gradient over life")),
    ("hue_random", "F", 0.0, dict(min=0, max=1, group="color", desc="Random hue rotation per particle (1 = any hue)")),
    ("inherit_color", "B", False, dict(group="color", desc="Children take this colour from their parent")),
    ("temp0", "F", 2200.0, dict(min=300, soft_max=8000, group="color", desc="Birth temperature in kelvin (Incandescent)")),
    ("temp_var", "F", 200.0, dict(min=0, soft_max=2000, group="color", desc="Random temperature variation (K)")),
    ("cool", "F", 0.5, dict(min=0, soft_max=10, group="color", desc="Newton cooling rate (1/s)")),
    ("cool_rad", "F", 0.0, dict(min=0, soft_max=10, group="color", desc="Radiative T^4 cooling: very hot things cool fast")),
    ("emit", "F", 10.0, dict(min=0, soft_max=500, group="color", desc="Emission strength")),
    ("emit_var", "F", 0.2, dict(min=0, max=1, group="color", desc="Random emission variation")),
    ("fade_in", "F", 0.02, dict(min=0, max=1, group="color", desc="Fraction of life to fade in")),
    ("fade_out", "F", 0.3, dict(min=0, max=1, group="color", desc="Fraction of life to fade out")),
    ("twinkle_freq", "F", 0.0, dict(min=0, soft_max=40, group="color", desc="Strobe / glitter flashes per second")),
    ("twinkle_amt", "F", 0.0, dict(min=0, max=1, group="color", desc="How dark the strobe goes between flashes")),

    ("collide", "E", "BOUNCE", dict(items=COLLIDE, group="collide", desc="Reaction to collider objects")),
    ("bounce", "F", 0.3, dict(min=0, max=1.5, group="collide", desc="Bounciness")),
    ("friction", "F", 0.2, dict(min=0, max=1, group="collide", desc="Sliding friction")),
    ("hit_kind", "K", "", dict(group="collide", desc="Spawn this type on impact")),
    ("hit_count", "F", 0.0, dict(min=0, soft_max=20, group="collide", desc="Children per impact (fractions are probabilities)")),
    ("hit_speed", "F", 2.0, dict(min=0, soft_max=50, unit="VELOCITY", group="collide", desc="Splash speed")),

    ("death_kind", "K", "", dict(group="death", desc="Spawn this type when the particle dies (bursts, shells)")),
    ("death_count", "I", 0, dict(min=0, max=4000, group="death", desc="Children per death")),
    ("death_pattern", "E", "SPHERE", dict(items=PATTERNS, group="death", desc="Burst shape")),
    ("death_speed", "F", 10.0, dict(min=0, soft_max=100, unit="VELOCITY", group="death", desc="Burst speed")),
    ("death_speed_var", "F", 0.15, dict(min=0, max=1, group="death", desc="Burst speed variation")),
    ("death_inherit", "F", 0.3, dict(soft_min=0, soft_max=1, group="death", desc="Share of parent velocity children keep")),

    ("trail_kind", "K", "", dict(group="trail", desc="Leave a trail of this type")),
    ("trail_rate", "F", 0.0, dict(min=0, soft_max=500, group="trail", desc="Trail particles per second")),
    ("trail_inherit", "F", 0.2, dict(soft_min=0, soft_max=1, group="trail", desc="Share of parent velocity")),
    ("trail_jitter", "F", 0.3, dict(min=0, soft_max=10, unit="VELOCITY", group="trail", desc="Random trail speed")),

    ("split_kind", "K", "", dict(group="split", desc="Break apart into this type at random moments (sparkler branching)")),
    ("split_rate", "F", 0.0, dict(min=0, soft_max=30, group="split", desc="Chance per second to split")),
    ("split_count", "I", 3, dict(min=0, max=255, group="split", desc="Pieces per split")),
    ("split_speed", "F", 3.0, dict(min=0, soft_max=50, unit="VELOCITY", group="split", desc="Speed of the pieces")),
    ("split_inherit", "F", 0.7, dict(soft_min=0, soft_max=1, group="split", desc="Share of parent velocity")),
    ("split_max_gen", "I", 3, dict(min=0, max=15, group="split", desc="Generations that may split again")),

    ("fl_smoke", "F", 0.0, dict(min=0, soft_max=50, group="fluid", desc="Smoke added to the fluid per second")),
    ("fl_heat", "F", 0.0, dict(min=0, soft_max=50, group="fluid", desc="Heat added to the fluid per second")),
    ("fl_fuel", "F", 0.0, dict(min=0, soft_max=50, group="fluid", desc="Fuel added to the fluid per second (particles that ignite)")),
]

KIND_GROUPS = [
    ("life", "Life & Size", "TIME"),
    ("motion", "Motion", "FORCE_FORCE"),
    ("color", "Color & Light", "LIGHT_SUN"),
    ("collide", "Collision", "MOD_PHYSICS"),
    ("death", "On Death: Burst", "OUTLINER_OB_FORCE_FIELD"),
    ("trail", "Trail", "CURVE_PATH"),
    ("split", "Split / Branch", "OUTLINER_DATA_LIGHTPROBE"),
    ("fluid", "Feed the Fluid", "MOD_FLUIDSIM"),
]

ENUM_INDEX = {
    "color_mode": [i[0] for i in COLOR_MODES],
    "death_pattern": [i[0] for i in PATTERNS],
    "collide": [i[0] for i in COLLIDE],
}


def pack_kind(kind, names):
    """Blender NovaKind -> dict of C params. names: list of kind names (for references)."""
    d = {}
    for name, t, _default, _o in KIND_SPEC:
        v = getattr(kind, name)
        if t == "C":
            pre = "c0" if name == "color" else "c1"
            d[pre + "r"], d[pre + "g"], d[pre + "b"] = v[0], v[1], v[2]
        elif t == "E":
            d[name] = ENUM_INDEX[name].index(v)
        elif t == "K":
            d[name] = names.index(v) if v in names else -1
        elif t == "B":
            d[name] = 1.0 if v else 0.0
        else:
            d[name] = float(v)
    return d


# ---------------------------------------------------------------- spectral colours

def _g(l, mu, s1, s2):
    s = np.where(l < mu, s1, s2)
    return np.exp(-0.5 * ((l - mu) / s) ** 2)


def _xyz(l):
    x = 1.056 * _g(l, 599.8, 37.9, 31.0) + 0.362 * _g(l, 442.0, 16.0, 26.7) - 0.065 * _g(l, 501.1, 20.4, 26.2)
    y = 0.821 * _g(l, 568.8, 46.9, 40.5) + 0.286 * _g(l, 530.9, 16.3, 31.1)
    z = 1.217 * _g(l, 437.0, 11.8, 36.0) + 0.681 * _g(l, 459.0, 26.0, 13.8)
    return np.stack([x, y, z], -1)


_XYZ2RGB = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])


def spectrum_rgb(lines):
    """Linear Rec.709 colour of an emission spectrum given as [(wavelength_nm, weight), ...],
    each line broadened to a ~6 nm Gaussian. Out-of-gamut parts are clipped, max channel = 1."""
    l = np.arange(380.0, 781.0, 1.0)
    s = np.zeros_like(l)
    for wl, w in lines:
        s += w * np.exp(-0.5 * ((l - wl) / 6.0) ** 2)
    XYZ = (_xyz(l) * s[:, None]).sum(0)
    rgb = np.clip(_XYZ2RGB @ XYZ, 0, None)
    return tuple(float(c) for c in rgb / max(rgb.max(), 1e-9))


# Firework colour chemistry: dominant molecular emitters in the flame.
CHEMISTRY = {
    "STRONTIUM": ("Strontium red", [(606, 0.35), (636, 0.7), (661, 1.0), (674, 0.8)]),
    "CALCIUM": ("Calcium orange", [(593, 1.0), (606, 0.4), (618, 0.8)]),
    "SODIUM": ("Sodium yellow", [(589, 1.0)]),
    "BARIUM": ("Barium green", [(507, 0.6), (513, 1.0), (524, 0.9), (532, 0.6)]),
    "COPPER": ("Copper blue", [(428, 0.8), (435, 1.0), (443, 0.9), (452, 0.6)]),
    "PURPLE": ("Strontium + copper purple", [(435, 1.0), (443, 0.8), (661, 0.75), (636, 0.4)]),
}


def chem(name, boost=1.0):
    c = spectrum_rgb(CHEMISTRY[name][1])
    return tuple(min(1.0, x * boost) for x in c)
