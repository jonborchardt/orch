/** Synthetic Claude Code transcripts for the Session tab tests; nothing here is real content. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const U = '11111111-2222-4333-8444-555555555555';

/** An ISO timestamp `s` seconds into a fixed minute. */
export const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + s * 1000).toISOString();
const line = (o: object) => JSON.stringify(o);
export const user = (s: number, content: unknown, extra: object = {}) =>
  line({
    type: 'user',
    timestamp: at(s),
    sessionId: U,
    message: { role: 'user', content },
    ...extra,
  });
export const assistant = (s: number, content: unknown, extra: object = {}) =>
  line({
    type: 'assistant',
    timestamp: at(s),
    sessionId: U,
    message: { role: 'assistant', content },
    ...extra,
  });

/** A main transcript with every record shape the reader handles. */
export function mainTranscript(): string {
  return [
    user(0, 'Please build the export button'),
    assistant(1, [{ type: 'thinking', thinking: 'secret reasoning' }]),
    assistant(2, [
      { type: 'text', text: 'Running the tests.' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'npm test', description: 'Run tests' },
      },
    ]),
    user(3, [{ type: 'tool_result', tool_use_id: 't1', content: '12 passed\nall good' }]),
    user(6, [
      {
        type: 'tool_result',
        tool_use_id: 't2',
        is_error: true,
        content: [{ type: 'text', text: 'boom' }],
      },
    ]),
    line({ type: 'system', level: 'error', timestamp: at(8), content: 'API error 529' }),
    line({ type: 'attachment', timestamp: at(9), attachment: { kind: 'file' } }),
    line({ type: 'queue-operation', timestamp: at(9), operation: 'enqueue' }),
    user(10, 'sidechain text in the main file', { isSidechain: true }),
    '{"type":"user","timest',
    assistant(11, [
      {
        type: 'tool_use',
        id: 't3',
        name: 'Agent',
        input: { subagent_type: 'factory-builder', description: 'Build round 1', prompt: 'long' },
      },
      { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    ]),
    '',
  ].join('\n');
}

/** Write `<claude>/projects/<dir>/<ref>.jsonl`; returns the project directory. */
export function writeSession(
  claude: string,
  dir = 'E--repo',
  body = mainTranscript(),
  ref = U,
): string {
  const project = join(claude, 'projects', dir);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${ref}.jsonl`), body);
  return project;
}

/** Write `<project>/<ref>/subagents/agent-<id>.jsonl`, and its meta file when given. */
export function writeAgent(project: string, id: string, body: string, meta?: object, ref = U) {
  const sub = join(project, ref, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${id}.jsonl`), body);
  if (meta) writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify(meta));
}
