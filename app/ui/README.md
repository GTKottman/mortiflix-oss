# Mortiflix Studio UI (Svelte)

The app screens as Svelte 5 components, so a shared piece (the top bar, the token counter, the Fix it strip)
is written once and every screen gets it. Owner, 2026-11-02: "We need to start having components."

Stack: Svelte 5 (runes) + TypeScript (strict) + Vite. No dev server and no new port: `vite build` writes
the app into `../web/app/`, and the bridge (`bridge.mjs`, http://127.0.0.1:4646) serves it at **/app/**.

## Commands

Run from the app repo root. Every build goes through the lock, so agents never build at the same time.

| Command                   | What it does                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tools/ui-build.sh`       | Builds into `../web/app/`, one build at a time. Open http://127.0.0.1:4646/app/                         |
| `tools/ui-build.sh check` | `npm run check`: types (`svelte-check`), lint (`eslint`), format (`prettier --check`), tests (`vitest`) |
| `npm run format`          | Formats every file                                                                                      |

The kit with every shared piece in its states: http://127.0.0.1:4646/app/#/kit

## Layout

```
src/
  main.ts                 starts the service client and mounts App with the app context
  App.svelte              the window: TopBar, FixItStrip, the screen for the route
  routes/                 hash paths -> screens (routes.ts), the stub, the kit
  screens/<folder>/       one folder per screen, found by itself (see "Adding a screen")
  lib/
    tokens.css            the design tokens: every colour, size, space and duration. The only place for values
    stages.ts             the stages, their order, and the count / Next rule
    router.svelte.ts      hash router (#/motion, #/kit)
    service/              the WebSocket client (client.ts) and the service's answer shapes (types.ts)
    stores/               app state as small classes with runes; context.ts hands them to components
    usage/                the token counter's data: types, normalize (service answer -> panel data), format, sample
    components/           the shared pieces, one per file
tests/                    vitest: service client, usage, stages
```

## How data flows

1. `main.ts` makes one `ServiceClient` (`lib/service/client.ts`), wraps it in the app context
   (`createAppContext`) and mounts `App` with it. The client queues calls until the socket opens,
   reconnects by itself and resends a call once if the service was restarting.
2. Stores (`lib/stores/`) hold what several pieces read: the open project and its stage statuses, the
   owner's settings, the problem list, the usage numbers. They listen to service events themselves
   (`status`, `settings.changed`, `usage.changed`), so components just read them.
3. A component gets what it needs with `useProject()`, `useService()`, `useProblems()`, `useSettings()`,
   `useUsage()`, `useRouter()`: nothing is passed down by hand.
4. Problems go to the Fix it strip with `useProblems().raise({ id, text, kind, fix })` and leave with
   `clear(id)`. Never show a "connected / OK" state (owner: errors only).

## Adding a screen

Screens register themselves: no shared file is edited.

1. Make the folder `src/screens/<folder>/`, where `<folder>` is today's page name in `web/screens/`
   (`home`, `new-project`, `lessons`, `settings`, `script`, `voice`, `look`, `stills`, `motion`, `sound`,
   `finish`). Put the screen in `<Name>Screen.svelte` (e.g. `screens/motion/MotionScreen.svelte`) and its own
   parts next to it. `routes/routes.ts` finds it with `import.meta.glob`; until the folder exists the route
   shows a stub that links to today's page.
2. The screen takes no props. Start with `<ScreenHead kicker="…" title="…" help="…" />`, then its work built
   from `lib/components/`. Stage screens put `<OptionsRow stage="…" target="…" />` under the head.
3. Read data with the `use*` helpers. Tell the top bar what the automatic count can't know with
   `useScreenBar()`: `count` ("Scene 2 of 6"), `why` (Next's disabled reason), `ownPrimary` (the screen has
   its own gradient button). They reset when the route changes.
4. A new shared component goes in its own new file in `lib/components/` and is listed in COMPONENTS.md.
5. Styles: use the tokens (`var(--s-16)`, `var(--muted)`…). A value that is not in `tokens.css` is added
   there first. One layer, hairlines, one gradient button per screen.
6. Build and check through the lock (one build at a time): `tools/ui-build.sh` and `tools/ui-build.sh check`.
   Screenshot at 1920×1080 and 1366×768:
   `BU_NAME=<unique> W=1920 H=1080 tools/shot-slot.sh tools/shot.sh "http://127.0.0.1:4646/app/index.html#/<path>" shots/ui/<name>.png`

Components and their props: [COMPONENTS.md](COMPONENTS.md).
