import { describe, expect, it } from 'vitest';
import {
  activeFilters,
  clip,
  hasNote,
  noteLine,
  NO_FILTERS,
  placePinned,
  sourceLine,
  totalsOf,
  visibleLessons,
} from '../src/screens/lessons/lessons';
import { LessonsView } from '../src/screens/lessons/lessons.svelte';
import { ServiceError } from '../src/lib/service/client';
import type { Lesson } from '../src/screens/lessons/types';

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  text: `Lesson ${id}`,
  section: 'Design',
  approved: true,
  on: true,
  scope: 'all',
  used: 0,
  ...over,
});

const LIST = [
  lesson('a', {
    approved: false,
    on: false,
    section: 'Motion',
    source: { note: 'The door was late', project: 'Black October' },
  }),
  lesson('b', { section: 'Sound', scope: 'project' }),
  lesson('c', { on: false }),
];

describe('filtering', () => {
  it('shows everything with no filters', () => {
    expect(visibleLessons(LIST, NO_FILTERS)).toHaveLength(3);
  });
  it('filters by section, scope and status together', () => {
    expect(visibleLessons(LIST, { ...NO_FILTERS, section: 'Sound' }).map((l) => l.id)).toEqual(['b']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, scope: 'project' }).map((l) => l.id)).toEqual(['b']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, scope: 'every' }).map((l) => l.id)).toEqual(['a', 'c']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, status: 'new' }).map((l) => l.id)).toEqual(['a']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, status: 'on' }).map((l) => l.id)).toEqual(['b']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, status: 'off' }).map((l) => l.id)).toEqual(['c']);
  });
  it('searches the words, the note and the project name', () => {
    expect(visibleLessons(LIST, { ...NO_FILTERS, query: 'DOOR' }).map((l) => l.id)).toEqual(['a']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, query: 'black oct' }).map((l) => l.id)).toEqual(['a']);
    expect(visibleLessons(LIST, { ...NO_FILTERS, query: 'nothing like this' })).toEqual([]);
  });
  it('counts waiting, on and off', () => {
    expect(totalsOf(LIST)).toEqual({ total: 3, waiting: 1, on: 1, off: 1 });
  });
  it('names what is filtered', () => {
    expect(activeFilters(NO_FILTERS, 'Black October')).toEqual([]);
    expect(
      activeFilters({ section: 'Sound', scope: 'project', status: 'off', query: ' door ' }, 'Black October'),
    ).toEqual(['Sound', 'Only Black October', 'Off', '“door”']);
    expect(activeFilters({ ...NO_FILTERS, scope: 'project' }, '')).toEqual(['Only this project']);
  });
});

describe('a note behind a lesson', () => {
  it('is there when the lesson has a note or a picture', () => {
    expect(hasNote(lesson('n', { source: { note: 'Too slow' } }))).toBe(true);
    expect(hasNote(lesson('p', { source: { image: '/stills/a.png' } }))).toBe(true);
  });
  it('is not there without either', () => {
    expect(hasNote(lesson('x'))).toBe(false);
    expect(hasNote(lesson('y', { source: { project: 'Black October' } }))).toBe(false);
  });
});

describe('words', () => {
  it('shortens long text with an ellipsis', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('a long sentence here', 10)).toBe('a long se…');
  });
  it('names the project a note came from, not its id', () => {
    const named = lesson('n', {
      source: { project: '261023-black-october-fa2f', project_title: 'Black October' },
    });
    expect(sourceLine(named)).toContain('Black October');
    expect(sourceLine(named)).not.toContain('261023');
  });
  it('gives where a lesson came from in one line', () => {
    const l = lesson('x', {
      used: 3,
      scope: 'project',
      source: { project: 'Black October', node: 'sf02', note: 'Title hides her eyes' },
    });
    expect(sourceLine(l)).toBe(
      'Black October · scene SF02 · your note: “Title hides her eyes” · used in 3 scenes · only this project',
    );
    expect(sourceLine(lesson('y', { used: 1 }))).toBe('used in 1 scene');
    expect(sourceLine(lesson('z', { approved: false, used: 5 }))).toBe('');
  });
  it('says where a marked note was made', () => {
    expect(
      noteLine(lesson('x', { source: { note: 'Too slow', frame: 12, project: 'P', node: 's02' } })),
    ).toBe('“Too slow” · frame 12 · P · S02');
    expect(noteLine(lesson('x'))).toBe('');
  });
});

describe('a decided lesson keeps its place', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => lesson(id));
  it('moves it back up to the place it had', () => {
    expect(placePinned(rows, new Map([['c', 0]])).map((l) => l.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('leaves it when the service already put it at or before that place', () => {
    expect(placePinned(rows, new Map([['a', 2]])).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('ignores a lesson that is gone', () => {
    expect(placePinned(rows, new Map([['zzz', 0]])).map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

function fakeService(answers: Record<string, unknown>) {
  const calls: { type: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    call: <T>(type: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ type, params });
      const answer = answers[type];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer as T);
    },
  };
}

describe('LessonsView', () => {
  it('loads the list', async () => {
    const service = fakeService({ 'lessons.list': { lessons: LIST } });
    const view = new LessonsView(service);
    await view.load();
    expect(view.phase).toBe('ok');
    expect(view.totals.total).toBe(3);
    expect(service.calls[0]).toEqual({ type: 'lessons.list', params: { scope: 'both' } });
  });
  it('says "coming" while the service does not know lessons yet', async () => {
    const view = new LessonsView(
      fakeService({ 'lessons.list': new ServiceError('unknown type', 'unknown_type') }),
    );
    await view.load();
    expect(view.phase).toBe('soon');
  });
  it('shows an error in words for any other failure', async () => {
    const view = new LessonsView(fakeService({ 'lessons.list': new Error('boom') }));
    await view.load();
    expect(view.phase).toBe('error');
    expect(view.error).toBe('boom');
  });
  it('pages the list and resets the page when a filter changes', async () => {
    const many = Array.from({ length: 20 }, (_, i) => lesson(String(i)));
    const view = new LessonsView(fakeService({ 'lessons.list': { lessons: many } }));
    await view.load();
    expect(view.visible).toHaveLength(8);
    expect(view.hidden).toBe(12);
    expect(view.more).toBe(12);
    view.showMore();
    expect(view.visible).toHaveLength(20);
    expect(view.more).toBe(0);
    view.setSection('Design');
    expect(view.visible).toHaveLength(8);
  });
  it('keeps a lesson just approved where it was, and lets go when it is undone', async () => {
    const waiting = lesson('w', { approved: false, on: false });
    const view = new LessonsView(fakeService({ 'lessons.list': { lessons: [waiting, lesson('b')] } }));
    await view.load();
    const service = fakeService({ 'lessons.list': { lessons: [lesson('b'), lesson('w')] } });
    const after = new LessonsView(service);
    after.lessons = view.lessons;
    await after.decide(waiting);
    expect(after.pinned.get('w')).toBe(0);
    expect(after.rows.map((l) => l.id)).toEqual(['w', 'b']);
    expect(after.decided).toBe(true);

    const undone = new LessonsView(
      fakeService({ 'lessons.list': { lessons: [lesson('b'), lesson('w', { on: false })] } }),
    );
    undone.pinned.set('w', 0);
    await undone.decide(waiting);
    expect(undone.pinned.has('w')).toBe(false);
  });
  it('waits to reload while a card is pinned or being edited', async () => {
    const service = fakeService({ 'lessons.list': { lessons: LIST } });
    const view = new LessonsView(service);
    view.editing = 'a';
    view.changed();
    expect(service.calls).toHaveLength(0);
    view.editing = null;
    view.changed();
    await Promise.resolve();
    expect(service.calls).toHaveLength(1);
  });
  it('switches a lesson and offers Undo, or says why it could not', async () => {
    const l = lesson('c', { on: true });
    const ok = new LessonsView(fakeService({ 'lessons.toggle': {} }));
    await ok.toggle(l, false);
    expect(l.on).toBe(false);
    expect(ok.offId).toBe('c');

    const refused = lesson('c', { on: true });
    const bad = new LessonsView(fakeService({ 'lessons.toggle': new Error('disk full') }));
    await bad.toggle(refused, false);
    expect(refused.on).toBe(true);
    expect(bad.notice).toBe('Could not save that: disk full');
  });
  it('says when the list could not be read after a decision', async () => {
    const view = new LessonsView(fakeService({ 'lessons.list': new Error('gone') }));
    await view.decide(lesson('w', { approved: false }));
    expect(view.notice).toBe('Saved, but the list could not be read again: gone');
  });
  it('refuses to save a lesson with no words, and unpins an edited card', async () => {
    const service = fakeService({ 'lessons.edit': {}, 'lessons.list': { lessons: LIST } });
    const view = new LessonsView(service);
    await expect(view.save(lesson('a'), '   ', 'Design')).rejects.toThrow('no words');
    expect(service.calls).toHaveLength(0);
    view.pinned.set('a', 0);
    await view.save(lesson('a'), ' New words ', 'Sound');
    expect(service.calls[0]).toEqual({
      type: 'lessons.edit',
      params: { id: 'a', text: 'New words', section: 'Sound' },
    });
    expect(view.pinned.has('a')).toBe(false);
  });

  it('moves a lesson between every project and only its project', async () => {
    const service = fakeService({ 'lessons.edit': {}, 'lessons.list': { lessons: LIST } });
    const view = new LessonsView(service);
    await view.moveScope(lesson('a', { scope: 'all' }), 'project');
    expect(service.calls[0]).toEqual({ type: 'lessons.edit', params: { id: 'a', scope: 'project' } });
  });
  it('deletes a lesson with Undo, or says why Undo failed', async () => {
    const service = fakeService({
      'lessons.delete': {},
      'lessons.restore': {},
      'lessons.list': { lessons: LIST },
    });
    const view = new LessonsView(service);
    await view.remove(lesson('a'));
    expect(view.removed?.id).toBe('a');
    await view.undoRemove();
    expect(service.calls.map((c) => c.type)).toContain('lessons.restore');
    expect(view.removed).toBeNull();

    const bad = new LessonsView(
      fakeService({
        'lessons.delete': {},
        'lessons.restore': new Error('not in the trash'),
        'lessons.list': { lessons: LIST },
      }),
    );
    await bad.remove(lesson('b'));
    await bad.undoRemove();
    expect(bad.notice).toBe('Could not bring the lesson back: not in the trash');
    expect(bad.removed?.id).toBe('b');
  });
});
