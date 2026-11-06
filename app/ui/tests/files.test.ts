import { describe, expect, it } from 'vitest';
import { fileUrl, revealFile, thumbUrl } from '../src/lib/files';

describe('studio file addresses', () => {
  it('serves studio paths through the bridge', () => {
    expect(fileUrl('/home/me/Mortiflix/a b.png')).toBe('/file?path=%2Fhome%2Fme%2FMortiflix%2Fa%20b.png');
    expect(thumbUrl('/s/a.png', 5000)).toBe('/thumb?path=%2Fs%2Fa.png&w=1280');
  });

  it("passes the app's own fixtures and data addresses through", () => {
    expect(fileUrl('/screens/fixtures/look-sf01-opening.png')).toBe(
      '/screens/fixtures/look-sf01-opening.png',
    );
    expect(thumbUrl('/screens/fixtures/still.png', 192)).toBe('/screens/fixtures/still.png');
    expect(thumbUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
  });
});

describe('Open folder', () => {
  it('asks the service to show the file and says so', async () => {
    const calls: [string, unknown][] = [];
    const client = {
      call: <T>(type: string, given?: Record<string, unknown>) => {
        calls.push([type, given]);
        return Promise.resolve({} as T);
      },
    };
    expect(await revealFile(client, '/s/p/final.mp4')).toBe('Folder opened.');
    expect(calls).toEqual([['files.reveal', { path: '/s/p/final.mp4' }]]);
  });

  it("says the service's reason when it refuses", async () => {
    const client = {
      call: <T>(): Promise<T> => Promise.reject(new Error('Only files inside the studio can be shown.')),
    };
    expect(await revealFile(client, '/etc/passwd')).toBe('Only files inside the studio can be shown.');
  });
});
