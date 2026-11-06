// Real words of the Black October script (six scenes, voiced) for fixture=6. Screenshots and tests only.
import type { Beat, VoiceLine } from './types';

/** A scene as written, before it has a state. */
export type WrittenBeat = Omit<Beat, 'state'>;

export const BLACK_OCTOBER: WrittenBeat[] = [
  {
    id: 'b01',
    no: 1,
    name: 'Call it Black October',
    visual:
      "The title 'Black October' builds on 'call it' over a grainy dark textured background, then a stack of plain-text bug names slides in on 'pile of serious bugs'.",
    target_sec: 8.8,
    lines: [
      { id: 'b01-1', words: 'So, this week?' },
      { id: 'b01-2', words: 'Call it Black October.' },
      {
        id: 'b01-3',
        words: 'A pile of serious bugs went public at once, some already used in real attacks.',
      },
    ],
  },
  {
    id: 'b02',
    no: 2,
    name: 'PHP2Shell, the big one',
    visual:
      "'PHP2Shell' as plain text in our own look over a simple drawn engine under a row of website cards. A stranger figure walks past an unlocked server door. Small captions: CVE-2026-109618 · CVE-2026-109619 · CVSS 9.2.",
    target_sec: 16.8,
    lines: [
      { id: 'b02-1', words: 'The big one is called PHP2Shell.' },
      {
        id: 'b02-2',
        words: 'PHP is the engine quietly running a huge share of the web, WordPress included.',
      },
      { id: 'b02-3', words: 'These two bugs let a stranger take over a server without logging in.' },
      { id: 'b02-4', words: 'The details leaked early, and attackers jumped right in.' },
    ],
  },
  {
    id: 'b03',
    no: 3,
    name: 'Plex2Shell at home',
    visual:
      "A cosy living-room shelf with a small home server box and film reels. 'Plex2Shell' as plain text with the number 4 popping on 'Four'. Small caption: CVE-2026-96652, -96654, -96655, -96656 · on CISA's exploited list.",
    target_sec: 7.6,
    lines: [
      { id: 'b03-1', words: 'Got a Plex server at home for your movies?' },
      { id: 'b03-2', words: 'Four bugs there, nicknamed Plex2Shell, are being exploited right now.' },
    ],
  },
  {
    id: 'b04',
    no: 4,
    name: "Businesses' own fires",
    visual:
      "Two plain-text office-building cards, 'GitLab' and 'Siemens', each with a small flame. Small captions: GitLab CVE-2026-110264 · CVSS 10.0; Siemens Software Center CVE-2026-110936 · actively exploited.",
    target_sec: 4.8,
    lines: [
      { id: 'b04-1', words: 'And businesses have their own fires too, in GitLab and Siemens software.' },
    ],
  },
  {
    id: 'b05',
    no: 5,
    name: "Today's to-do list",
    visual:
      "A three-item checklist card. Each number and line pops on the word that says it, with a tick drawn as it's spoken. Small caption under step one: fixed PHP 8.5.12 · 8.4.27 · 8.3.36 · 8.2.35.",
    target_sec: 17.6,
    lines: [
      { id: 'b05-1', words: "So here's today's list." },
      { id: 'b05-2', words: 'One: run a website?' },
      {
        id: 'b05-3',
        words: 'Ask your host if PHP is updated, or check the PHP version in your control panel.',
      },
      { id: 'b05-4', words: 'Two: update your plugins, apps and devices, and switch on automatic updates.' },
      { id: 'b05-5', words: 'Three: running Plex at home?' },
      { id: 'b05-6', words: 'Update it now.' },
    ],
  },
  {
    id: 'b06',
    no: 6,
    name: 'Patch now',
    visual:
      "A front door's key turns and morphs into an 'update' arrow, then the end card reads 'Patch now.' with 'Black October' small beneath it.",
    target_sec: 4.4,
    lines: [
      { id: 'b06-1', words: 'Like locking your front door: small job, big difference.' },
      { id: 'b06-2', words: 'Patch now.' },
    ],
  },
];

export const BLACK_OCTOBER_VOICE: VoiceLine[] = [
  { node: 'b01-1', start_sec: 0, dur_sec: 1.52, path: '/fx/voice.mp3' },
  { node: 'b01-2', start_sec: 1.87, dur_sec: 1.915, path: '/fx/voice.mp3' },
  { node: 'b01-3', start_sec: 4.135, dur_sec: 6.146, path: '/fx/voice.mp3' },
  { node: 'b02-1', start_sec: 10.981, dur_sec: 3.16, path: '/fx/voice.mp3' },
  { node: 'b02-2', start_sec: 14.879, dur_sec: 6.094, path: '/fx/voice.mp3' },
  { node: 'b02-3', start_sec: 21.323, dur_sec: 4.895, path: '/fx/voice.mp3' },
  { node: 'b02-4', start_sec: 26.568, dur_sec: 4.057, path: '/fx/voice.mp3' },
  { node: 'b03-1', start_sec: 31.325, dur_sec: 2.56, path: '/fx/voice.mp3' },
  { node: 'b03-2', start_sec: 34.235, dur_sec: 5.542, path: '/fx/voice.mp3' },
  { node: 'b04-1', start_sec: 40.477, dur_sec: 5.238, path: '/fx/voice.mp3' },
  { node: 'b05-1', start_sec: 46.415, dur_sec: 1.84, path: '/fx/voice.mp3' },
  { node: 'b05-2', start_sec: 48.605, dur_sec: 2.159, path: '/fx/voice.mp3' },
  { node: 'b05-3', start_sec: 51.114, dur_sec: 6.16, path: '/fx/voice.mp3' },
  { node: 'b05-4', start_sec: 57.624, dur_sec: 6.071, path: '/fx/voice.mp3' },
  { node: 'b05-5', start_sec: 64.045, dur_sec: 2.748, path: '/fx/voice.mp3' },
  { node: 'b05-6', start_sec: 67.143, dur_sec: 1.398, path: '/fx/voice.mp3' },
  { node: 'b06-1', start_sec: 69.241, dur_sec: 4.284, path: '/fx/voice.mp3' },
  { node: 'b06-2', start_sec: 73.875, dur_sec: 1.071, path: '/fx/voice.mp3' },
];
