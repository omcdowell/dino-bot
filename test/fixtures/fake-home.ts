/** A fake HOME with one small history per supported agent, for the auto-import tests and the speed check. */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';

const jsonl = (path: string, items: unknown[]) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n');
};
const json = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

/** `scale` repeats each project's conversations, for a speed measurement. */
export function fakeHome(home: string, scale = 1) {
  for (let n = 0; n < scale; n++) {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 1 + (n % 28), 10, min)).toISOString();
    // pi: a session in ~/code/app, then a fork of it that copies the first exchange and adds one.
    const pi = (id: string, extra: unknown[] = [], parent?: string) => [
      { type: 'session', version: 3, id, timestamp: t(0), cwd: '/home/u/code/app', ...(parent ? { parentSession: parent } : {}) },
      { type: 'model_change', id: 'mc', provider: 'anthropic', modelId: 'claude-sonnet-5-5' },
      { type: 'message', id: `u1-${n}`, timestamp: t(1), message: { role: 'user', content: [{ type: 'text', text: 'Add a login page' }] } },
      {
        type: 'message',
        id: `a1-${n}`,
        timestamp: t(2),
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'Reading files' },
            { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
          ],
        },
      },
      {
        type: 'message',
        id: `r1-${n}`,
        timestamp: t(3),
        message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
      },
      {
        type: 'message',
        id: `a2-${n}`,
        timestamp: t(4),
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Login page added at /login.' },
          ],
        },
      },
      ...extra,
    ];
    jsonl(join(home, `.pi/agent/sessions/--home-u-code-app--/2026-09-01_pi-${n}.jsonl`), pi(`pi-${n}`));
    jsonl(
      join(home, `.pi/agent/sessions/--home-u-code-app--/2026-09-02_fork-${n}.jsonl`),
      pi(
        `fork-${n}`,
        [
          { type: 'message', id: `u2-${n}`, timestamp: t(5), message: { role: 'user', content: 'Now add logout' } },
          {
            type: 'message',
            id: `a3-${n}`,
            timestamp: t(6),
            message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'partial' }] },
          },
        ],
        `pi-${n}`,
      ),
    );
    // pi in a throwaway folder: found, unticked by default.
    jsonl(join(home, `.pi/agent/sessions/--tmp-x--/2026-09-01_tmp-${n}.jsonl`), [
      { type: 'session', version: 3, id: `tmp-${n}`, timestamp: t(0), cwd: '/tmp/x' },
      { type: 'message', id: `t1-${n}`, timestamp: t(1), message: { role: 'user', content: 'smoke test' } },
    ]);
    // Claude Code
    const cc = { sessionId: `cc-${n}`, cwd: '/home/u/code/api' };
    jsonl(join(home, `.claude/projects/-home-u-code-api/cc-${n}.jsonl`), [
      { ...cc, type: 'user', uuid: `cu1-${n}`, timestamp: t(10), message: { role: 'user', content: 'Why is the API slow?' } },
      {
        ...cc,
        type: 'assistant',
        uuid: `ca1-${n}`,
        timestamp: t(11),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'An N+1 query in /orders.' }] },
      },
    ]);
    // Codex CLI
    jsonl(join(home, `.codex/sessions/2026/09/01/rollout-${n}.jsonl`), [
      { type: 'session_meta', timestamp: t(20), payload: { id: `cx-${n}`, cwd: '/home/u/code/api', timestamp: t(20) } },
      {
        type: 'response_item',
        timestamp: t(21),
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write a migration' }] },
      },
      {
        type: 'response_item',
        timestamp: t(22),
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Migration 004 written.' }] },
      },
      { type: 'event_msg', timestamp: t(22), payload: { type: 'task_complete' } },
    ]);
    // Cursor agent: one native transcript, and one driven by pi (already in pi's history, so skipped).
    jsonl(join(home, `.cursor/projects/home-u-code-web/agent-transcripts/cu-${n}/cu-${n}.jsonl`), [
      {
        role: 'user',
        message: { content: [{ type: 'text', text: '<timestamp>Mon</timestamp>\n<user_query>\nFix the navbar\n</user_query>' }] },
      },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking' },
            { type: 'tool_use', name: 'read', input: {} },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Navbar fixed.' }] } },
    ]);
    jsonl(join(home, `.cursor/projects/home-u-code-web/agent-transcripts/agent-${n}/agent-${n}.jsonl`), [
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nCursor SDK tool boundary:\nhello\n</user_query>' }] } },
    ]);
    // Gemini CLI
    json(join(home, `.gemini/tmp/web/chats/session-${n}.json`), {
      sessionId: `gm-${n}`,
      startTime: t(30),
      messages: [
        { id: 'g1', timestamp: t(30), type: 'user', content: 'Explain the build' },
        { id: 'g2', timestamp: t(31), type: 'gemini', content: 'Checking', toolCalls: [{ name: 'ls' }] },
        { id: 'g3', timestamp: t(32), type: 'gemini', content: 'Vite builds it.' },
      ],
    });
    writeFileSync(join(home, '.gemini/tmp/web/.project_root'), '/home/u/code/web\n');
  }
  // A bot's own folder: its chats are in its memory already, so it is unticked by default.
  mkdirSync(join(home, 'bots/flint'), { recursive: true });
  writeFileSync(join(home, 'bots/flint/.optchat-profile'), 'flint\n');
  jsonl(join(home, '.pi/agent/sessions/--bots-flint--/2026-09-01_bot.jsonl'), [
    { type: 'session', version: 3, id: 'bot-1', timestamp: '2026-09-01T00:00:00Z', cwd: join(home, 'bots/flint') },
    { type: 'message', id: 'b1', timestamp: '2026-09-01T00:01:00Z', message: { role: 'user', content: 'bot chat' } },
  ]);
  // Claude Code memory (once)
  mkdirSync(join(home, '.claude/projects/-home-u-code-api/memory'), { recursive: true });
  writeFileSync(
    join(home, '.claude/projects/-home-u-code-api/memory/db.md'),
    '---\nname: Database\n---\nPostgres 17, migrations in db/.\n',
  );
  const old = new Date('2026-09-01T00:00:00Z');
  utimesSync(join(home, '.claude/projects/-home-u-code-api/memory/db.md'), old, old);
}
