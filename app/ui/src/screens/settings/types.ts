// The shapes Settings reads besides `setup.status` (see lib/setup/status.ts). Field names are the service's.

/** `videonotes.status` / `videonotes.setup`: reviewing scenes on the owner's tablet. */
export interface VideoNotesStatus {
  enabled: boolean;
  /** Where finished videos wait, as a path on this computer. */
  folder?: string;
  addresses?: TabletAddress[];
  /** When the tablet last checked in (ISO time). */
  tablet_seen?: string | null;
  problems?: string[];
}

export interface TabletAddress {
  kind?: 'tailscale' | 'local';
  label?: string;
  url: string;
  reachable?: boolean;
}

/** One entry of `components.status`. */
export interface ComponentStatus {
  id: string;
  name: string;
  installed: boolean;
  default?: boolean;
}

export interface ComponentsAnswer {
  components?: ComponentStatus[];
}

/** `settings.get` / `settings.set` `lan`: home-network access (the bridge listens to it; off by default). */
export interface LanSettings {
  /** On now: the saved switch, or MFX_BRIDGE_LAN=1. */
  enabled: boolean;
  /** The Settings switch as saved. */
  saved: boolean;
  /** MFX_BRIDGE_LAN=1 started the bridge (tools/serve-lan.sh): on whatever the switch says. */
  forced: boolean;
  /** The addresses other devices open, when on. */
  addresses: TabletAddress[];
}

/** `settings.get` / `settings.set` `paid`: the daily ElevenLabs credit cap. */
export interface CapSettings {
  /** Credits per day, or null = no cap. */
  daily_cap: number | null;
  /** ElevenLabs credits booked today (this computer's day). */
  spent_today: number;
}

/** The part of `settings.get` the Home network switch and the credit cap read. */
export interface AccessSettings {
  lan?: LanSettings;
  paid?: CapSettings;
}
