import { BLACK_OCTOBER, BLACK_OCTOBER_VOICE, type WrittenBeat } from './fixture-data';
import type { ScriptSource } from './source';
import { WORDS_PER_MINUTE, wordsOf } from './timing';
import type { Beat, EditResult, ScriptData, VoiceLine } from './types';
import type { StudioOption } from '../../lib/service/types';

// Fixtures for the Script screen: open #/script?fixture=6|20|40|loading|error|writing|first-words|empty. Nothing is
// sent to the service and nothing is saved anywhere. writing = two scenes so far, the last line still being written;
// first-words = writing, no scene yet; empty = no scene and nothing writing.

export const FIXTURE_MODES = [
  '6',
  '20',
  '40',
  'loading',
  'error',
  'writing',
  'first-words',
  'empty',
] as const;
export type FixtureMode = (typeof FIXTURE_MODES)[number];

export const isFixtureMode = (value: string | null): value is FixtureMode =>
  FIXTURE_MODES.some((mode) => mode === value);

const LATENCY_MS = 60;

const TOPICS: readonly (readonly [string, string])[] = [
  [
    'A bug nobody noticed',
    'Plain text title over a dark grainy ground. A small lock icon cracks open as the word "bug" is spoken.',
  ],
  [
    'Who is affected',
    'A row of small website cards; three of them turn amber one by one as the number is spoken.',
  ],
  [
    'What attackers do',
    'A stranger figure walks past an unlocked server door; a caption names the weakness in plain words.',
  ],
  [
    'The patch',
    'A download arrow lands on a server box and a green check draws itself beside the version number.',
  ],
  [
    'Why it matters at home',
    'A cosy living-room shelf with a home server and film reels; one caption: "Updates are on by default."',
  ],
  ['Your to-do list', 'A short checklist builds line by line, matching each spoken step.'],
];

const SAY: readonly string[] = [
  'Here is what happened this week.',
  'It sounds scary, but the fix is small.',
  'Most people never see the bug itself.',
  'What matters is that a patch is already out.',
  'Check the version you run, and update it today.',
  'If you cannot update, turn the feature off until you can.',
];

/** Written, not voiced yet: `count` scenes of two to four lines. */
function written(count: number): WrittenBeat[] {
  return Array.from({ length: count }, (_, i) => {
    const [topic, visual] = TOPICS[i % TOPICS.length] ?? TOPICS[0] ?? ['', ''];
    const id = `b${String(i + 1).padStart(2, '0')}`;
    const lines = Array.from({ length: 2 + (i % 3) }, (_, j) => ({
      id: `${id}-${j + 1}`,
      words: SAY[(i + j) % SAY.length] ?? '',
    }));
    const words = lines.reduce((sum, l) => sum + wordsOf(l.words), 0);
    const plan = (words / WORDS_PER_MINUTE) * 60 * (0.95 + 0.1 * (i % 3));
    return {
      id,
      no: i + 1,
      name: count > 6 ? `${topic} ${Math.floor(i / TOPICS.length) + 1}` : topic,
      visual,
      target_sec: Math.round(plan * 10) / 10,
      lines,
    };
  });
}

function scenesFor(mode: FixtureMode): Beat[] {
  const count = mode === '20' ? 20 : mode === '40' ? 40 : 6;
  const source = mode === '20' || mode === '40' ? written(count) : structuredClone(BLACK_OCTOBER);
  const beats: Beat[] = source.map((beat, i) => ({
    ...beat,
    state: i % 3 === 2 ? 'approved' : 'ready',
    lines: beat.lines.map((line) => ({ ...line, read_only: false, changed: false })),
  }));
  if (mode !== 'writing') return beats;
  const two = beats.slice(0, 2);
  const last = two[1]?.lines.at(-1);
  if (last) last.read_only = true;
  return two;
}

export const FIXTURE_OPTIONS = (scene: boolean): StudioOption[] => [
  {
    id: 'o1',
    label: 'Shorter',
    does: scene ? 'Trims this scene by about a third.' : 'Trims every scene to fit the length you chose.',
  },
  {
    id: 'o2',
    label: 'Stronger hook',
    does: scene
      ? 'Makes the first line of this scene land harder.'
      : 'Rewrites the opening of the whole script.',
  },
  {
    id: 'o3',
    label: 'Plainer words',
    does: scene
      ? 'Swaps jargon in this scene for everyday words.'
      : 'Swaps jargon everywhere for everyday words.',
  },
  {
    id: 'o4',
    label: 'Clearer call',
    does: scene ? 'Makes what to do next plain in this scene.' : 'Makes the closing ask plainer.',
  },
];

const later = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));

export function fixtureSource(mode: FixtureMode): ScriptSource {
  const beats = scenesFor(mode);
  const voice: VoiceLine[] = mode === '6' ? structuredClone(BLACK_OCTOBER_VOICE) : [];
  let revision = 0;
  /** Lines removed in this session, so Undo can put them back where they were. */
  const hidden: { beat: string; at: number; line: Beat['lines'][number] }[] = [];
  return {
    isFixture: true,
    script() {
      if (mode === 'loading') return new Promise<ScriptData>(() => undefined);
      if (mode === 'error') return Promise.reject(new Error('The service did not answer in time.'));
      if (mode === 'empty' || mode === 'first-words')
        return later({ project: 'fixture', rev: 1, writing: mode === 'first-words', beats: [], draft: null });
      return later({ project: 'fixture', rev: ++revision, writing: mode === 'writing', beats, draft: null });
    },
    voice: () => later(voice),
    edit(edits): Promise<EditResult> {
      const out: Required<Pick<EditResult, 'changed' | 'added' | 'deleted'>> = {
        changed: [],
        added: [],
        deleted: [],
      };
      const keys: Record<string, string> = {};
      for (const edit of edits) {
        const beat = beats.find((b) => b.id === edit.beat);
        if (!beat) continue;
        beat.state = 'ready';
        if (edit.add_after !== undefined) {
          const after = edit.add_after === null ? null : (keys[edit.add_after] ?? edit.add_after);
          const at = after === null ? 0 : beat.lines.findIndex((l) => l.id === after) + 1;
          const id = `${beat.id}-${beat.lines.length + hidden.filter((h) => h.beat === beat.id).length + 1}`;
          beat.lines.splice(at, 0, { id, words: edit.words ?? '', changed: true });
          if (edit.key) keys[edit.key] = id;
          out.added.push(id);
          continue;
        }
        if (edit.delete === true) {
          const at = beat.lines.findIndex((l) => l.id === edit.line);
          const [gone] = at >= 0 ? beat.lines.splice(at, 1) : [];
          if (gone) {
            hidden.push({ beat: beat.id, at, line: gone });
            out.deleted.push(gone.id);
          }
          continue;
        }
        if (edit.delete === false) {
          const i = hidden.findIndex((h) => h.line.id === edit.line);
          const [back] = i >= 0 ? hidden.splice(i, 1) : [];
          if (back) beat.lines.splice(Math.min(back.at, beat.lines.length), 0, back.line);
          continue;
        }
        const line = beat.lines.find((l) => l.id === edit.line);
        if (!line || edit.words === undefined) continue;
        line.words = edit.words;
        line.changed = true;
        const said = voice.find((v) => v.node === line.id);
        if (said) said.words_changed = true;
        out.changed.push(line.id);
      }
      return later({ ...out, remaking: [] });
    },
    decide(node, action) {
      const beat = beats.find((b) => b.id === node);
      if (beat) beat.state = action === 'ok' ? 'approved' : 'ready';
      return later(undefined);
    },
    fixScene(node) {
      const beat = beats.find((b) => b.id === node);
      if (beat) beat.state = 'ready';
      return later(undefined);
    },
    fixScript: () => later(undefined),
    voicePaid: () => later(mode === '6'),
    keepDraft: () => later(undefined),
  };
}
