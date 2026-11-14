/**
 * Execution-session metadata: which Claude session is (or was) driving a job. This is metadata,
 * never workflow state: the job id, the lease, the worktree, the evidence, and the PR do not
 * depend on it, and a job may be resumed by a different session at any time.
 */
import { ValidationError } from './errors.ts';

export const SESSION_PROVIDERS = ['vscode-agents', 'claude-code'] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/** Event type recording an association; the newest one is the current session. */
export const SESSION_EVENT = 'session.attached';

export interface SessionRef {
  /**
   * `vscode-agents`: a session in VS Code's Agents window (the host's `create_session` /
   * `get_current_session` tools); `ref` is the `agent-host-session://` link they return.
   * `claude-code`: a Claude Code conversation; `ref` is its session UUID (`claude --resume`).
   */
  provider: SessionProvider;
  ref: string;
  /** Working directory the session reported, when known. */
  cwd: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_LINK = /^agent-host-session:\/\/[\w-]+\/[\w-]+$/;

export function validateSessionRef(provider: string, ref: string, cwd?: string): SessionRef {
  if (!SESSION_PROVIDERS.includes(provider as SessionProvider)) {
    throw new ValidationError(`Session provider must be one of ${SESSION_PROVIDERS.join(', ')}.`);
  }
  const r = ref.trim();
  if (provider === 'vscode-agents' && !HOST_LINK.test(r)) {
    throw new ValidationError(
      'A vscode-agents ref is the agent-host-session://<kind>/<id> link the host tools return.',
    );
  }
  if (provider === 'claude-code' && !UUID.test(r)) {
    throw new ValidationError('A claude-code ref is the session UUID (claude --resume <uuid>).');
  }
  return { provider: provider as SessionProvider, ref: r, cwd: cwd ?? null };
}

export interface SessionLinks {
  /**
   * Where the session can be opened. `vscode-chat` links resolve only inside VS Code (chat and
   * Agents window Markdown); the scheme has no operating-system handler, so a browser cannot
   * open them. `os` links are handled by the operating system (`vscode://`).
   */
  open: { url: string; scope: 'vscode-chat' | 'os' } | null;
  /** Terminal command that resumes the same conversation, when one is documented. */
  resume: string | null;
  /** One line a UI shows next to the link, so an unsupported case is never a dead control. */
  note: string;
}

/** Documented navigation per provider; nothing here is guessed from private storage. */
export function sessionLinks(s: SessionRef): SessionLinks {
  switch (s.provider) {
    case 'vscode-agents':
      return {
        open: { url: s.ref, scope: 'vscode-chat' },
        resume: null,
        note:
          'Opens from inside VS Code only (paste the link into a chat, or pick the session in the ' +
          'Agents window); no browser handler exists for agent-host-session links.',
      };
    case 'claude-code':
      return {
        open: {
          url: `vscode://anthropic.claude-code/open?session=${encodeURIComponent(s.ref)}`,
          scope: 'os',
        },
        resume: `claude --resume ${s.ref}`,
        note:
          'The VS Code link resumes the session in the window whose folder contains it; the CLI ' +
          'command resumes it in a terminal from any directory.',
      };
  }
}
