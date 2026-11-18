import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Memory } from '../src/memory.ts';
import { RunLog, userText } from '../src/run-log.ts';

const PLACEHOLDER = '[image attachment: available in Pi session; text memory does not preserve image bytes]';
const png = Buffer.from('89504e470d0a1a0a-not-really-a-png');
const jpg = Buffer.from('ffd8ffe0-not-really-a-jpeg');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function withMemory(run: (memory: Memory, dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-images-'));
  const memory = new Memory(
    join(dir, 'memory'),
    async input => input.source.slice(0, 100),
    () => {},
  );
  return Promise.resolve(run(memory, dir)).finally(async () => {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('a pi user message keeps its images in the profile and names them by path, as a Claude Code bot does', () =>
  withMemory((memory, dir) => {
    const images = join(dir, 'images');
    const log = new RunLog(memory, true, images);
    log.write({
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'text',
          text: 'what is this?\n\n[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]',
        },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'image', data: jpg.toString('base64'), mimeType: 'image/jpeg' },
      ],
    });
    log.end();
    const pngPath = join(images, `${sha(png)}.png`),
      jpgPath = join(images, `${sha(jpg)}.jpg`);
    assert.equal(
      memory.root[0].text,
      `what is this?\n[image: ${pngPath} (read the file to see it)]\n[image: ${jpgPath} (read the file to see it)]`,
    );
    assert.deepEqual(readFileSync(pngPath), png);
    assert.deepEqual(readFileSync(jpgPath), jpg);
  }));

test('an image sent alone is just its line, and a resent image is one file', () =>
  withMemory((memory, dir) => {
    const images = join(dir, 'images');
    const log = new RunLog(memory, false, images);
    const message = {
      role: 'user',
      timestamp: 0,
      content: [
        { type: 'text', text: '' },
        { type: 'image', data: jpg.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
    log.write(message);
    log.write({ ...message, timestamp: 1 });
    assert.equal(memory.root[0].text, `[image: ${join(images, `${sha(jpg)}.jpg`)} (read the file to see it)]`);
    assert.equal(memory.root[1].text, memory.root[0].text);
    assert.deepEqual(readdirSync(images), [`${sha(jpg)}.jpg`]);
  }));

test('without an images folder (or for a tool result) an image stays the text placeholder', () =>
  withMemory(memory => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ];
    new RunLog(memory, false).write({ role: 'user', timestamp: 0, content });
    assert.equal(memory.root[0].text, `look\n${PLACEHOLDER}`);
    assert.equal(userText('plain text', '/nowhere'), 'plain text');
  }));

test('an image that cannot be written leaves the placeholder, and the message is still logged', () =>
  withMemory((memory, dir) => {
    const blocked = join(dir, 'memory', 'view.json', 'images'); // under a file: mkdir fails
    new RunLog(memory, false, blocked).write({
      role: 'user',
      timestamp: 0,
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    });
    assert.equal(memory.root[0].text, `hi\n${PLACEHOLDER}`);
  }));
