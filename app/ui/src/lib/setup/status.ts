// What `setup.status` says about this computer (Claude Code, keys, tools). Home raises problems from it and
// Settings shows it. Field names are the service's (snake_case).

export interface ClaudeStatus {
  found?: boolean;
  logged_in?: boolean;
  version?: string;
  subscription?: string;
  login_command?: string | string[];
}

export interface KeyStatus {
  id: string;
  set?: boolean;
}

/** A tool is reported as a flag or as `{ ok }` / `{ found }`. */
export type ToolStatus = boolean | { ok?: boolean; found?: boolean };

export interface SetupStatus {
  first_run?: boolean;
  claude?: ClaudeStatus;
  keys?: KeyStatus[];
  tools?: Record<string, ToolStatus | null | undefined>;
}

export const DEFAULT_LOGIN_COMMAND = 'claude auth login';

/** Claude Code is installed and signed in. */
export const claudeConnected = (claude: ClaudeStatus | undefined): boolean =>
  !!(claude?.found && claude.logged_in);

/** The command the owner runs in a terminal to sign in. */
export function loginCommand(claude: ClaudeStatus | undefined): string {
  const command = claude?.login_command;
  if (Array.isArray(command)) return command.join(' ');
  return command || DEFAULT_LOGIN_COMMAND;
}

export function toolReady(tool: ToolStatus): boolean {
  if (typeof tool === 'boolean') return tool;
  return !!(tool.ok ?? tool.found);
}
