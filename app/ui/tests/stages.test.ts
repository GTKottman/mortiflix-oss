import { describe, expect, it } from 'vitest';
import { isStageDone, nextStage, stageById, stageCount, statusFor, STAGE_LINE } from '../src/lib/stages';

describe('stages', () => {
  it('shows six stages in the line and leads Sound to Finish', () => {
    expect(STAGE_LINE.map((s) => s.label)).toEqual([
      'Script',
      'Voice & music',
      'Look',
      'Stills',
      'Motion',
      'Sound',
    ]);
    expect(nextStage('sound')?.id).toBe('finish');
    expect(nextStage('finish')).toBeNull();
  });

  it('finds a stage status by any of its keys', () => {
    const status = statusFor(stageById('voice'), [{ key: 'voiceMusic', kind: 'done' }]);
    expect(isStageDone(status)).toBe(true);
    expect(isStageDone(null)).toBe(false);
  });

  it('is done only when every step is approved, done or skipped', () => {
    const voice = { key: 'voiceMusic', kind: 'done', done: 15, total: 15 };
    const step = (state: string) => ({ key: 'voice', name: 'Voice', state });
    expect(isStageDone({ ...voice, steps: [step('in_review')] })).toBe(false);
    expect(isStageDone({ ...voice, steps: [step('approved'), { ...step('skipped'), key: 'music' }] })).toBe(
      true,
    );
  });

  it('counts what is OK and opens Next when all is', () => {
    const stills = stageById('stills');
    expect(stageCount(stills, { key: 'stills', done: 4, ok: 4, total: 6 })).toEqual({
      text: '4 of 6 stills OK',
      ready: false,
      why: '2 of 6 stills still need your OK',
    });
    expect(stageCount(stills, { key: 'stills', done: 6, ok: 6, total: 6 })).toEqual({
      text: '6 of 6 stills OK',
      ready: true,
    });
    expect(stageCount(stills, null)).toEqual({
      text: 'Waiting for Stills',
      ready: false,
      why: 'Waiting for Stills',
    });
    expect(
      stageCount(stageById('voice'), { key: 'voice', done: 2, ok: 2, total: 3, text: '2/3 lines' }).text,
    ).toBe('2 of 3 lines OK');
  });

  it('says Finish on the Finish stage', () => {
    expect(stageCount(stageById('finish'), null)).toEqual({ text: 'Finish', ready: false });
  });
});

// Dir2 (2026-11-02): Look said "3 of 3 looks OK · Next: Stills" with 0 frames OK'd, before and after the frames loaded.
describe('the top bar counts OKs, not what is made', () => {
  for (const id of ['look', 'stills', 'motion', 'sound'] as const) {
    const stage = stageById(id);
    it(`${id}: 3 made, 0 OK'd reads 0 of 3 OK`, () => {
      expect(stageCount(stage, { key: id, done: 3, ok: 0, total: 3 }).text).toBe(`0 of 3 ${stage.noun} OK`);
    });
    it(`${id}: no count before the statuses load`, () => {
      expect(stageCount(stage, null, false)).toEqual({ text: '', ready: false });
      expect(stageCount(stage, { key: id, done: 3, ok: 3, total: 3 }, false).text).toBe('');
    });
  }
  it('an older service without ok says made, never OK', () => {
    expect(stageCount(stageById('look'), { key: 'look', done: 3, total: 3 }).text).toBe('3 of 3 looks made');
  });
});

// Owner's gate rule (2026-11-02): Next waits until the stage's step is approved (every piece OK'd or cut), greyed with
// a hover reason; the same rule StageLine uses to grey later stages.
describe('Next waits for the approval', () => {
  const look = stageById('look');
  it('all made, 1 of 3 OK: greyed, says how many still need the OK', () => {
    expect(stageCount(look, { key: 'look', done: 3, ok: 1, total: 3 })).toEqual({
      text: '1 of 3 looks OK',
      ready: false,
      why: '2 of 3 looks still need your OK',
    });
  });
  it('every piece OK (cut ones are not counted in total): Next opens', () => {
    expect(stageCount(look, { key: 'look', done: 3, ok: 3, total: 3 }).ready).toBe(true);
  });
  it('the step approved (StageLine opens the next stage): Next opens', () => {
    const steps = [{ key: 'style-frames', name: 'Style frames', state: 'approved' }];
    expect(stageCount(look, { key: 'look', done: 3, total: 3, steps }).ready).toBe(true);
  });
  it('an older service without ok: Next waits for the step approval', () => {
    const steps = [{ key: 'style-frames', name: 'Style frames', state: 'in_review' }];
    expect(stageCount(look, { key: 'look', done: 3, total: 3, steps })).toEqual({
      text: '3 of 3 looks made',
      ready: false,
      why: 'Look needs your OK first',
    });
  });
});

// Dir1 bdb9 (2026-11-02): all 7 frames OK'd, style-frames still in review (Next is what approves it). Next must open.
describe('bdb9: every frame OK, the step still in review', () => {
  it('Next opens, and says 7 of 7 looks OK', () => {
    const steps = [{ key: 'style-frames', name: 'Style frames', state: 'in_review' }];
    expect(
      stageCount(stageById('look'), {
        key: 'look',
        kind: 'ready',
        done: 7,
        ok: 7,
        total: 7,
        need: 0,
        text: '7/7 style frames ready',
        steps,
      }),
    ).toEqual({ text: '7 of 7 looks OK', ready: true });
  });
});
