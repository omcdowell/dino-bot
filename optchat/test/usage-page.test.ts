import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { short, UsagePanel } from '../src/usage-page.ts';
import { UsageLedger } from '../src/usage.ts';

test('usage panel lines up costs per role and model, cycles periods, resizes, and closes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-usage-'));
  const usage = new UsageLedger(dir),
    controller = new AbortController();
  const spend = (role: 'main' | 'compactor', model: string, cost: number, provider?: string) =>
    usage.add({
      date: new Date().toISOString(),
      role,
      model,
      provider,
      session: 'parent',
      usage: {
        input: 0,
        output: 164_000,
        cacheRead: 900,
        cacheWrite: 100,
        totalTokens: 165_000,
        cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    });
  spend('main', 'claude-opus-5-5', 20.5, 'anthropic');
  spend('main', 'evil\n\x1b[2Jmodel', 0);
  spend('compactor', 'claude-sonnet-5-5', 60, 'anthropic');
  spend('compactor', 'claude-sonnet-5-5', 3.35);
  let rows = 24,
    closed = 0;
  const page = new UsagePanel({
    profile: 'personal',
    session: 'parent',
    usage,
    rows: () => rows,
    redraw: () => {},
    done: () => {
      closed++;
    },
    color: (_tone, text) => text,
    context: () => 123,
    signal: controller.signal,
  });
  try {
    const table = page.render(100).filter(l => /main|compactor/.test(l));
    // A provider-less older record shares its model's row; costs line up on the right.
    assert.deepEqual(
      table.map(l => l.trim().split(/\s+/)),
      [
        ['main', 'claude-opus-5-5', '$20.50', '24%', '164k', '90%'],
        ['compactor', 'claude-sonnet-5-5', '$63.35', '76%', '328k', '90%'],
      ],
    );
    assert.equal(table[0].indexOf('$20.50') + 6, table[1].indexOf('$63.35') + 6);
    // A model name read from disk can't break the table or send terminal codes.
    assert.ok(page.render(100).some(l => /evil \[2Jmodel +\$0\.00/.test(l)));
    assert.ok(page.render(100).every(l => !l.includes('\x1b')));
    assert.doesNotMatch(page.render(40).join('\n'), /claude-/);
    page.handleInput('\x1b[C');
    assert.match(page.render(100).join('\n'), /\[Last.hour\]/);
    rows = 16;
    const narrow = page.render(40);
    assert.ok(narrow.length <= Math.floor(rows * 0.9));
    assert.ok(narrow.every(line => visibleWidth(line) <= 40));
    controller.abort();
    page.handleInput('\x1b');
    assert.equal(closed, 1);
  } finally {
    page.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('short numbers move up a unit instead of showing 1000', () => {
  assert.deepEqual([999, 999.6, 12_345, 164_000, 999_499, 999_500, 999_500_000, 2_400_000].map(short), [
    '999',
    '1k',
    '12.3k',
    '164k',
    '999k',
    '1M',
    '1B',
    '2.4M',
  ]);
});
