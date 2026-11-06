import { describe, expect, it } from 'vitest';
import { fixtureSource } from '../src/screens/script/fixtures';
import { ScriptStore } from '../src/screens/script/script.svelte';
import type { Problems } from '../src/lib/stores/problems.svelte';
import type { LineEdit } from '../src/screens/script/types';

const problems = { raise: () => undefined, clear: () => undefined } as unknown as Problems;

describe('editing a scene: remove and add lines', () => {
  it('sends a removed line as delete and added lines in order, and Undo puts it all back', async () => {
    const source = fixtureSource('6');
    const sent: LineEdit[][] = [];
    const edit = source.edit.bind(source);
    source.edit = (edits) => {
      sent.push(edits);
      return edit(edits);
    };
    const store = new ScriptStore(source, problems, null);
    await store.load();
    const beat = store.beats[1];
    if (!beat) throw new Error('no scene 2');
    const [first, second] = beat.lines;
    if (!first || !second) throw new Error('scene 2 needs two lines');
    store.startEdit(beat);
    store.setDraft(beat, second.id, '   ');
    const a = store.addLine(beat);
    store.setNewLine(beat, a, 'A new closing line.');
    const b = store.addLine(beat);
    store.setNewLine(beat, b, 'And one more.');
    store.addLine(beat); // left empty: not sent
    expect(store.hasUnsavedEdit).toBe(true);
    await store.save(beat);
    const last = beat.lines.filter((l) => l.id !== second.id).at(-1)?.id;
    expect(sent[0]).toEqual([
      { beat: beat.id, line: second.id, delete: true },
      { beat: beat.id, add_after: last, words: 'A new closing line.', key: 'n1' },
      { beat: beat.id, add_after: 'n1', words: 'And one more.', key: 'n2' },
    ]);
    const after = store.beats[1];
    if (!after) throw new Error('no scene 2');
    expect(after.lines.map((l) => l.words)).toContain('And one more.');
    expect(after.lines.some((l) => l.id === second.id)).toBe(false);
    await store.undo(after);
    const undone = sent[1] ?? [];
    expect(undone[0]).toEqual({ beat: beat.id, line: second.id, delete: false });
    expect(undone.filter((e) => e.delete === true)).toHaveLength(2);
    expect(store.beats[1]?.lines.some((l) => l.id === second.id)).toBe(true);
    expect(store.beats[1]?.lines.map((l) => l.words)).not.toContain('And one more.');
  });
});
