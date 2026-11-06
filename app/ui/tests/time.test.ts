import { describe, expect, it } from 'vitest';
import { clock, clockTenths, pad2 } from '../src/lib/time';
import { plural } from '../src/lib/words';

describe('clock', () => {
  it('prints minutes and seconds, rounded', () => {
    expect(clock(83.4)).toBe('1:23');
    expect(clock(59.6)).toBe('1:00');
    expect(clock(5)).toBe('0:05');
  });
  it('never prints a negative or broken time', () => {
    expect(clock(-3)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('0:00');
    expect(clock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('clock, truncated', () => {
  it('drops the part of a second', () => {
    expect(clock(74.6, { truncate: true })).toBe('1:14');
    expect(clock(74.96, { truncate: true })).toBe('1:15');
    expect(clock(59.5, { truncate: true })).toBe('0:59');
    expect(clock(Number.NaN, { truncate: true })).toBe('0:00');
  });
});

describe('clockTenths', () => {
  it('prints minutes, seconds and tenths', () => {
    expect(clockTenths(74.9)).toBe('1:14.9');
    expect(clockTenths(83.44)).toBe('1:23.4');
    expect(clockTenths(59.96)).toBe('1:00.0');
    expect(clockTenths(0.25)).toBe('0:00.3');
  });
  it('never prints a negative or broken time', () => {
    expect(clockTenths(-1)).toBe('0:00.0');
    expect(clockTenths(Number.NaN)).toBe('0:00.0');
  });
});

describe('pad2', () => {
  it('pads to two digits', () => {
    expect(pad2(7)).toBe('07');
    expect(pad2(12)).toBe('12');
  });
});

describe('plural', () => {
  it('adds an s unless there is one', () => {
    expect(plural(1, 'scene')).toBe('1 scene');
    expect(plural(0, 'scene')).toBe('0 scenes');
    expect(plural(3, 'scene')).toBe('3 scenes');
  });
  it('takes an irregular plural', () => {
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
});
