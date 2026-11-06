import { describe, expect, it } from 'vitest';
import type { StillLine, StillsState } from '../src/lib/review/types';
import {
  drawAllState,
  lineVersions,
  makingWords,
  sceneGroups,
  sceneTag,
  stillViews,
  stillsHead,
} from '../src/screens/stills/stills';

const line = (id: string, state: StillLine['state'], path = '/p/x-v2.png'): StillLine => ({
  line: id,
  words: `Words of ${id}`,
  state,
  path,
  version: 2,
  versions: 2,
});

const demo: StillsState = {
  mode: 'lines',
  lines: [line('b01-1', 'ok'), line('b01-2', 'check'), line('b02-1', 'todo', '')],
};

describe('stills', () => {
  it('makes scenes from the beats when the service sends none', () => {
    const groups = sceneGroups(demo);
    expect(groups.map((g) => [g.name, g.state, g.lines.length])).toEqual([
      ['Scene 1', 'review', 2],
      ['Scene 2', 'waiting', 1],
    ]);
  });

  it('derives version paths from the -vN.png naming when only a count is sent', () => {
    expect(lineVersions(line('a', 'ok')).map((v) => v.path)).toEqual(['/p/x-v1.png', '/p/x-v2.png']);
  });

  it('labels each still with its scene and what OK means next', () => {
    const views = stillViews(demo, []);
    expect(views[0]?.item.label).toBe('Scene 1 · still 1 of 2');
    expect(views[0]?.item.okWords.none).toBe('OK · Next still');
    expect(views[1]?.item.okWords.none).toBe('OK · Next group');
    expect(views[2]?.item.okWords.none).toBe('OK · Done');
  });

  it("takes a still's notes from the notes list when the line carries none", () => {
    const views = stillViews(demo, [{ id: 'n1', node: 'b01-2', text: 'Bigger', pending: true }]);
    expect(views[1]?.item.pending).toBe(1);
    expect(views[0]?.item.notes).toEqual([]);
  });

  it('writes the head and the waiting scene tag', () => {
    const views = stillViews(demo, []);
    expect(stillsHead(demo, views[1] ?? null).kicker).toBe('Stills · Scene 1 of 2 · Still 2 of 2');
    const second = sceneGroups(demo)[1];
    expect(second && sceneTag(second).text).toBe('Waits for scene 1');
  });

  it('shows Draw all only on the demo studio, then its progress', () => {
    expect(drawAllState(demo, null)).toEqual({ kind: 'ready', count: 1 });
    expect(drawAllState({ ...demo, mode: 'groups' }, null)).toEqual({ kind: 'none' });
    expect(drawAllState(demo, { total: 3 })).toEqual({ kind: 'busy', text: 'Drawing 3 of 3' });
  });

  it('says how long drawing has run, and what a failed or remade still is', () => {
    const drawing: StillsState = { mode: 'lines', lines: [line('b01-1', 'drawing', '')] };
    const [view] = stillViews(drawing, []);
    const words = makingWords(view ?? null, '', 'Working for 1:05.');
    expect(words.title).toBe('◌ Drawing scene 1…');
    expect(words.body.startsWith('Working for 1:05. ')).toBe(true);
    expect(makingWords(view ?? null, '').body.startsWith('The whole scene')).toBe(true);

    const fixing = stillViews({ mode: 'lines', lines: [line('b01-1', 'fix', '')] }, [])[0];
    expect(makingWords(fixing ?? null, '').title).toBe('◌ Drawing this still again…');

    const failed = stillViews(
      { mode: 'lines', lines: [{ ...line('b01-1', 'todo', ''), error: 'Out of memory' }] },
      [],
    )[0];
    expect(makingWords(failed ?? null, '')).toEqual({
      title: 'This still could not be drawn',
      body: 'Out of memory',
    });
  });

  it('never says scene 1 waits for the look (the look is OK on Stills); a scene to check says "Your check"', () => {
    const todo = stillViews({ mode: 'groups', lines: [line('b01-1', 'todo', '')] }, [])[0];
    expect(makingWords(todo ?? null, '')).toEqual({ title: 'Not drawn yet', body: '' });
    const groups = sceneGroups(demo);
    expect(groups[0] && sceneTag(groups[0]).text).toBe('Your check');
  });

  it('shows what the studio measured wrong on a held still, never a pass over a failing check', () => {
    const held = {
      ...line('b01-1', 'held'),
      held: ['Studio check · no-collisions: 1 overlap'],
      problems: ['no-collisions: 1 overlap'],
    };
    expect(stillViews({ mode: 'groups', lines: [held] }, [])[0]?.item.problems).toEqual([
      'no-collisions: 1 overlap',
    ]);
    expect(stillViews({ mode: 'groups', lines: [{ ...held, state: 'ok' }] }, [])[0]?.item.problems).toEqual(
      [],
    );
  });
});
