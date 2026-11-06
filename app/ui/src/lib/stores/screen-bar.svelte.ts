// What the screen on view tells the top bar: its own count, why Next is not usable yet, and whether it has
// its own gradient button (then Next is an outline). Screens set these with useScreenBar(); the app clears
// them when the route changes, so one screen's words never stay on the next.

export class ScreenBar {
  /** Overrides the automatic count, e.g. "Scene 2 of 6" or "Look picked: Look A". */
  count = $state<string | undefined>(undefined);
  /** Why Next cannot be used yet; shown in the count's place while Next is disabled. */
  why = $state<string | undefined>(undefined);
  /** The screen has its own gradient button: Next becomes an outline button. */
  ownPrimary = $state(false);

  reset(): void {
    this.count = undefined;
    this.why = undefined;
    this.ownPrimary = false;
  }
}
