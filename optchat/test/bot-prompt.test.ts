import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botSection } from '../src/bot-prompt.ts';

test('botSection reads the OPTCHAT_BOT_PROMPT file, and is empty without the plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-botprompt-'));
  try {
    const file = join(dir, 'b.md');
    writeFileSync(file, '# DinoBot bot\nrules\n\n');
    assert.equal(botSection({ OPTCHAT_BOT_PROMPT: file }), '# DinoBot bot\nrules');
    assert.equal(botSection({}), '');
    assert.equal(botSection({ OPTCHAT_BOT_PROMPT: join(dir, 'missing.md') }), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
