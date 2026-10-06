/* Parameter tables shared by the CPU core and the GPU backend (X-macros). */
#pragma once

/* Per particle-type ("kind") parameters. */
#define KIND_PARAMS(X)                                                                    \
  X(life_min, 1.0) X(life_max, 2.0)                                                       \
  X(gravity, 1.0) X(drag_lin, 0.0) X(drag_quad, 0.0) X(buoyancy, 0.0) X(turb, 1.0)        \
  X(fluid_drag, 0.0) X(wind, 1.0) X(force, 1.0)                                           \
  X(size_start, 0.02) X(size_end, 0.01) X(size_var, 0.2) X(size_curve, 1.0)               \
  X(color_mode, 0) X(c0r, 1.0) X(c0g, 0.6) X(c0b, 0.2) X(c1r, 1.0) X(c1g, 0.2)            \
  X(c1b, 0.05) X(color_var, 0.1) X(color_curve, 1.0) X(hue_random, 0.0)                   \
  X(inherit_color, 0)                                                                     \
  X(temp0, 2200) X(temp_var, 200) X(cool, 0.5) X(cool_rad, 0.0)                           \
  X(emit, 10) X(emit_var, 0.2) X(fade_in, 0.02) X(fade_out, 0.3)                          \
  X(twinkle_freq, 0) X(twinkle_amt, 0)                                                    \
  X(collide, 1) X(bounce, 0.3) X(friction, 0.2)                                           \
  X(death_kind, -1) X(death_count, 0) X(death_pattern, 0) X(death_speed, 10)              \
  X(death_speed_var, 0.15) X(death_inherit, 0.3)                                          \
  X(trail_kind, -1) X(trail_rate, 0) X(trail_inherit, 0.2) X(trail_jitter, 0.3)           \
  X(split_kind, -1) X(split_rate, 0) X(split_count, 3) X(split_speed, 3)                  \
  X(split_inherit, 0.7) X(split_max_gen, 3)                                               \
  X(hit_kind, -1) X(hit_count, 0) X(hit_speed, 2)                                         \
  X(fl_smoke, 0) X(fl_heat, 0) X(fl_fuel, 0)

/* Global particle-system parameters. */
#define SYS_PARAMS(X)                                                                     \
  X(gx, 0) X(gy, 0) X(gz, -9.81) X(wx, 0) X(wy, 0) X(wz, 0)                               \
  X(turb_amp, 0) X(turb_freq, 0.5) X(turb_speed, 0.5) X(turb_octaves, 2)                  \
  X(max_particles, 2000000) X(seed, 0) X(t_ambient, 293)

/* Fluid solver parameters. Temperature is in "kilo-kelvin above ambient". */
#define FLUID_PARAMS(X)                                                                   \
  X(buoy_heat, 2.0) X(buoy_smoke, 0.3) X(vorticity, 0.35) X(cool, 0.4) X(cool_rad, 0.08)  \
  X(smoke_decay, 0.02) X(vel_decay, 0.0) X(fuel_decay, 0.0)                               \
  X(ignite, 0.25) X(burn_rate, 2.0) X(heat_release, 1.5) X(smoke_yield, 0.6)              \
  X(expansion, 1.0) X(flame_decay, 8.0)                                                   \
  X(turb_amp, 0.0) X(turb_freq, 1.0) X(turb_speed, 0.5)                                   \
  X(wind_x, 0) X(wind_y, 0) X(wind_z, 0) X(wind_drag, 0)                                  \
  X(cfl, 2.5) X(max_sub, 4) X(cg_tol, 1e-3) X(cg_iter, 60)                                \
  X(maccormack, 1) X(reflect, 1) X(closed_floor, 1) X(seed, 0) X(sparse, 1)

#define NV_E_F(n, d) FP_##n,
enum { FLUID_PARAMS(NV_E_F) FP_COUNT };
