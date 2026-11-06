import type { ServiceClient } from '../../lib/service/client';
import type { Beat, Decision, EditResult, LineEdit, ScriptData, VoiceLine } from './types';

/** Everything the Script screen asks of the outside. The service answers it live; fixtures answer it for tests and shots. */
export interface ScriptSource {
  /** Fixtures never touch the service, so the options row is fed from here too. */
  readonly isFixture: boolean;
  script(): Promise<ScriptData>;
  voice(): Promise<VoiceLine[]>;
  edit(edits: LineEdit[]): Promise<EditResult>;
  decide(node: string, action: Decision): Promise<void>;
  /** Whether an OK spends ElevenLabs credits (each OK records that scene's voice there): voice.list engine + key. */
  voicePaid(): Promise<boolean>;
  /** Fix on one scene: the owner's words go to Mortiflix, which rewrites that scene (node.edit fix). */
  fixScene(node: string, text: string): Promise<void>;
  /**
   * Fix on the whole script: sends the script back with the owner's words (review.respond changes), or, once it is
   * approved, reopens its stage with them (stage.reopen; `reopen` is the stage key).
   */
  fixScript(text: string, reopen?: string | null): Promise<void>;
  /** Keeps unsaved edits across a reload; null clears them. */
  keepDraft(lines: Record<string, string> | null): Promise<void>;
}

/** `script.get` sends `visual: null` for a scene without one; the screen reads a missing visual as undefined. */
type WireBeat = Omit<Beat, 'visual'> & { visual?: string | null };

export function serviceSource(client: ServiceClient): ScriptSource {
  return {
    isFixture: false,
    script: async () => {
      const data = await client.call<Omit<ScriptData, 'beats'> & { beats: WireBeat[] }>('script.get');
      return {
        ...data,
        beats: data.beats.map(({ visual, ...beat }) => ({ ...beat, visual: visual ?? undefined })),
      };
    },
    voice: () => client.call<VoiceLine[]>('voice.lines'),
    edit: (edits) => client.call<EditResult>('script.edit', { edits }),
    decide: async (node, action) => {
      await client.call('node.edit', { node, action });
    },
    voicePaid: async () => {
      // Cost first (service paid.ask_first): an OK records nothing; the voice waits for its own cost OK.
      const cost = await client
        .call<{ ask_first?: boolean }>('step.cost', { step: 'voice' })
        .catch(() => null);
      if (cost?.ask_first) return false;
      const list = await client.call<{ engine?: string; elevenlabs_key?: unknown }>('voice.list');
      return list.engine === 'elevenlabs' && Boolean(list.elevenlabs_key);
    },
    fixScene: async (node, text) => {
      await client.call('node.edit', { node, action: 'fix', text });
    },
    fixScript: async (text, reopen) => {
      if (reopen) await client.call('stage.reopen', { stage: reopen, text });
      else await client.call('review.respond', { step: 'script', verdict: 'changes', notes: text });
    },
    keepDraft: async (lines) => {
      await client.call('script.draft', { draft: lines ? { lines } : null });
    },
  };
}
