import { describe, expect, it } from 'vitest';
import { ServiceError, type ServiceClient } from '../src/lib/service/client';
import { DEFAULT_SETTINGS, Settings } from '../src/lib/stores/settings.svelte';
import { claudeConnected, loginCommand, toolReady } from '../src/lib/setup/status';
import { otherRows } from '../src/screens/settings/other';
import { REVIEW_SETTINGS } from '../src/screens/settings/reviews';
import { SettingsPage } from '../src/screens/settings/settings-page.svelte';
import { ago, folderWords, labelled } from '../src/screens/settings/video-notes';

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

describe('setup status', () => {
  it('is connected only when found and signed in', () => {
    expect(claudeConnected({ found: true, logged_in: true })).toBe(true);
    expect(claudeConnected({ found: true })).toBe(false);
    expect(claudeConnected(undefined)).toBe(false);
  });
  it('gives the command to sign in', () => {
    expect(loginCommand({ login_command: ['claude', 'auth', 'login'] })).toBe('claude auth login');
    expect(loginCommand({ login_command: 'claude login' })).toBe('claude login');
    expect(loginCommand(undefined)).toBe('claude auth login');
  });
  it('reads a tool as a flag or an object', () => {
    expect(toolReady(true)).toBe(true);
    expect(toolReady({ ok: false })).toBe(false);
    expect(toolReady({ found: true })).toBe(true);
  });
});

describe('Other connections', () => {
  const components = [
    { id: 'blender', name: 'Blender', installed: true },
    { id: 'strudel', name: 'Strudel', installed: false },
    { id: 'transitions', name: 'Transitions', installed: false, default: false },
    { id: 'qwen-image', name: 'Qwen', installed: false },
  ];
  it('uses plain names, hides removed local generation and flags what is missing', () => {
    expect(otherRows(components, null)).toEqual([
      { name: '3D shots (Blender)', ready: true, needsFix: false },
      { name: 'Music writing', ready: false, needsFix: true },
      { name: 'Transitions', ready: false, needsFix: false },
    ]);
  });
  it('adds the video tools and Node from the setup status', () => {
    const rows = otherRows([], { tools: { ffmpeg: { ok: true }, node: false } });
    expect(rows).toEqual([
      { name: 'Video tools', ready: true, needsFix: false },
      { name: 'Node', ready: false, needsFix: true },
    ]);
  });
});

describe('Video Notes words', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  it('says how long ago the tablet checked in', () => {
    expect(ago('2026-11-02T12:00:00Z', now)).toMatch(/^just now \(/);
    expect(ago('2026-11-02T11:55:00Z', now)).toMatch(/^5 min ago \(/);
    expect(ago('2026-11-02T09:00:00Z', now)).toMatch(/^3 h ago \(/);
    expect(ago('2026-10-20T09:00:00Z', now)).toMatch(/^20 Oct \(/);
  });
  it('writes the folder as Morti Drive > …', () => {
    expect(folderWords('/home/user/MortiDrive/files/Video Notes')).toBe('Morti Drive › Video Notes');
    expect(folderWords('/elsewhere/notes')).toBe('/elsewhere/notes');
  });
  it('names the addresses', () => {
    const rows = labelled([
      { kind: 'tailscale', url: 'a' },
      { kind: 'local', url: 'b' },
      { kind: 'local', url: 'c' },
      { kind: 'local', url: 'd', label: 'Office' },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Tailscale', 'Home network', 'Home network (2nd)', 'Office']);
  });
});

describe('Reviews steppers', () => {
  it('read and write their own number', () => {
    const [options, frames, scenes] = REVIEW_SETTINGS;
    expect(options?.read(DEFAULT_SETTINGS)).toBe(4);
    const changed = frames?.write(DEFAULT_SETTINGS, 5);
    expect(changed?.review).toEqual({ framesPerRound: 5, scenesPerGroup: 1 });
    expect(changed?.options).toEqual(DEFAULT_SETTINGS.options);
    expect(scenes?.request(2)).toEqual({ review: { scenesPerGroup: 2 } });
  });
});

describe('SettingsPage', () => {
  it('tells first run from the service', async () => {
    const page = new SettingsPage(fakeService({ 'setup.status': { first_run: true } }));
    await page.loadStatus();
    expect(page.firstRun).toBe(true);
  });
  it('tells still checking from failed, for status, keys and the other connections', async () => {
    const page = new SettingsPage(
      fakeService({
        'setup.status': new Error('service is down'),
        'keys.list': [],
        'components.status': new Error('no list'),
      }),
    );
    expect(page.statusError).toBeNull();
    expect(page.keysLoaded).toBe(false);
    expect(page.componentsError).toBeNull();
    await Promise.all([page.loadStatus(), page.loadKeys(), page.loadComponents()]);
    expect(page.statusError).toBe('service is down');
    expect(page.keysLoaded).toBe(true);
    expect(page.voiceKeySet).toBe(false);
    expect(page.componentsError).toBe('no list');
  });
  it('checks again past the cache', async () => {
    const service = fakeService({ 'setup.status': { claude: { found: true, logged_in: true } } });
    const page = new SettingsPage(service);
    await page.recheck();
    expect(service.calls[0]).toEqual({ type: 'setup.status', params: { refresh: true } });
    expect(page.writingReady).toBe(true);
    expect(page.checking).toBe(false);
  });
  it('saves the key and reads the list again', async () => {
    const service = fakeService({
      'keys.set': {},
      'setup.status': {},
      'keys.list': [{ id: 'elevenlabs', set: true }],
    });
    const page = new SettingsPage(service);
    expect(await page.saveKey('sk-1')).toBe(true);
    expect(service.calls[0]).toEqual({ type: 'keys.set', params: { id: 'elevenlabs', value: 'sk-1' } });
    expect(page.voiceKeySet).toBe(true);
  });
  it('says why a key was not saved', async () => {
    const page = new SettingsPage(fakeService({ 'keys.set': new Error('bad key'), 'keys.list': [] }));
    expect(await page.saveKey('x')).toBe(false);
    expect(page.keyError).toBe('Not saved: bad key');
    expect(page.keyBusy).toBeNull();
  });
  it('knows when Video Notes is not built yet', async () => {
    const page = new SettingsPage(
      fakeService({ 'videonotes.status': new ServiceError('unknown', 'unknown_type') }),
    );
    await page.loadVideoNotes();
    expect(page.videoNotesSoon).toBe(true);
    expect(page.videoNotesError).toBeNull();
  });
  it('switches Video Notes and keeps the answer', async () => {
    const page = new SettingsPage(fakeService({ 'videonotes.setup': { enabled: true, addresses: [] } }));
    await page.setVideoNotes(true);
    expect(page.videoNotes?.enabled).toBe(true);
    expect(page.videoNotesBusy).toBe(false);
  });
  it('reports why finishing failed, or null', async () => {
    expect(await new SettingsPage(fakeService({ 'setup.done': {} })).finish()).toBeNull();
    expect(await new SettingsPage(fakeService({ 'setup.done': new Error('no disk') })).finish()).toBe(
      'no disk',
    );
  });
});

describe('Settings store', () => {
  const storeFor = (answer: unknown) =>
    new Settings({
      on: () => () => undefined,
      call: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
    } as unknown as ServiceClient);

  it('says why the settings could not be read and keeps the defaults', async () => {
    const settings = storeFor(new Error('service is down'));
    await settings.load();
    expect(settings.error).toBe('service is down');
    expect(settings.value).toEqual(DEFAULT_SETTINGS);
  });
  it('clears the error once a read works', async () => {
    const settings = storeFor({ options: { count: 6 }, review: { framesPerRound: 2, scenesPerGroup: 2 } });
    settings.error = 'earlier failure';
    await settings.load();
    expect(settings.error).toBeNull();
    expect(settings.optionsCount).toBe(6);
  });
  it('is not an error when the service has no settings yet', async () => {
    const settings = storeFor(new ServiceError('unknown', 'unknown_type'));
    await settings.load();
    expect(settings.error).toBeNull();
  });
});
