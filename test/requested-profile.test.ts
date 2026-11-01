import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROFILE_FILE, requestedProfile } from '../src/profiles.ts';

const folder = (content?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cwd-'));
  if (content !== undefined) writeFileSync(join(dir, PROFILE_FILE), content);
  return dir;
};

test('no flag, env or folder file asks for nothing', () => {
  assert.equal(requestedProfile(undefined, folder(), {}), undefined);
});

test('folder file names the profile, trimmed', () => {
  assert.equal(requestedProfile(undefined, folder('bitzer\n'), {}), 'bitzer');
});

test('OPTCHAT_PROFILE beats the folder file', () => {
  assert.equal(requestedProfile(undefined, folder('bitzer'), { OPTCHAT_PROFILE: 'flint' }), 'flint');
});

test('the flag beats env and folder file', () => {
  assert.equal(requestedProfile('scrat', folder('bitzer'), { OPTCHAT_PROFILE: 'flint' }), 'scrat');
});

test('blank env and blank folder file are ignored', () => {
  assert.equal(requestedProfile(undefined, folder('  \n'), { OPTCHAT_PROFILE: ' ' }), undefined);
});

test('an invalid folder name fails loudly instead of opening the picker', () => {
  assert.throws(() => requestedProfile(undefined, folder('Not A Name'), {}), /Profile names/);
});
