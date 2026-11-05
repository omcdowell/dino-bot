import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, liveCompactor, loadConfig, NO_MODELS_YET, saveConfig } from '../src/profiles.ts';

test('the compactor follows config.json written by another process; a bad file keeps the last good one', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'optchat-live-'));
  try {
    saveConfig(dir, { ...defaults, previousExchangeKB: 8 });
    const config = loadConfig(dir);
    const choice = liveCompactor(dir, config);
    assert.deepEqual(choice(), defaults.compactor);

    const glm = { provider: 'openrouter', model: 'z-ai/glm-5.3', thinking: 'high' as const };
    saveConfig(dir, { ...config, compactor: glm });
    utimesSync(join(dir, 'config.json'), new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual(choice(), glm);
    assert.deepEqual(config.compactor, glm, 'the open config shows the new choice');
    assert.equal(config.previousExchangeKB, 8, 'other settings are untouched');

    writeFileSync(join(dir, 'config.json'), '{ not json');
    utimesSync(join(dir, 'config.json'), new Date(), new Date(Date.now() + 10_000));
    assert.deepEqual(choice(), glm);
    rmSync(join(dir, 'config.json'));
    assert.deepEqual(choice(), glm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bot opened before its models were chosen gets a plain message, not ENOENT', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'optchat-nomodels-'));
  try {
    assert.throws(
      () => loadConfig(dir),
      (error: Error) => error.message === NO_MODELS_YET && !/ENOENT/.test(error.message),
    );
    assert.match(NO_MODELS_YET, /Choose models/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
