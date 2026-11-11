import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureRoot, claim, release, readJson, atomicJson, replaceFile } from '../src/store.mjs';

const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
function competitor(lock, token) {
  return new Promise(resolve => {
    const source = `import {claim} from ${JSON.stringify(moduleUrl)}; await claim(process.argv[1], {token:process.argv[2]}).then(()=>process.exit(0),()=>process.exit(2));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, lock, token],
      { stdio: 'ignore' });
    child.on('exit', code => resolve(code));
  });
}

test('replacement retries only bounded Windows sharing failures, without repeating data production', async () => {
  const waits = [];
  const sharing = Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  let attempts = 0;
  await replaceFile('synced.tmp', 'state.json', { platform: 'win32',
    move: async (source, target) => {
      assert.equal(source, 'synced.tmp');
      assert.equal(target, 'state.json');
      if (++attempts < 3) throw sharing;
    }, wait: async ms => waits.push(ms) });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 50]);
  attempts = 0;
  await assert.rejects(replaceFile('synced.tmp', 'state.json', { platform: 'win32',
    move: async () => { attempts++; throw sharing; }, wait: async () => {} }), error => error === sharing);
  assert.equal(attempts, 6);
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
    attempts = 0;
    await assert.rejects(replaceFile('synced.tmp', 'state.json', { platform,
      move: async () => { attempts++; throw Object.assign(new Error('persistent'), { code }); },
      wait: async () => assert.fail('Not a retryable sharing failure') }), { code });
    assert.equal(attempts, 1);
  }
});

test('atomic snapshots remain readable while a writer replaces them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const file = join(root, 'state.json');
  let done = false;
  try {
    await atomicJson(file, { version: 0 });
    await Promise.all([
      (async () => {
        try { for (let version = 1; version <= 30; version++) await atomicJson(file, { version }); }
        finally { done = true; }
      })(),
      ...Array.from({ length: 3 }, async () => {
        while (!done) assert.ok(Number.isInteger((await readJson(file)).version));
      }),
    ]);
    assert.equal((await readJson(file)).version, 30);
  } finally { done = true; await rm(root, { recursive: true, force: true }); }
});

test('real processes cannot both own a claim; release requires the owner token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-'));
  const lock = join(root, 'owner.lock');
  try {
    await ensureRoot(root);
    const outcomes = await Promise.all([competitor(lock, 'one'), competitor(lock, 'two')]);
    assert.deepEqual(outcomes.sort(), [0, 2]);
    const winner = (await readJson(lock)).token;
    await assert.rejects(release(lock, winner === 'one' ? 'two' : 'one'), /Ownership changed/);
    await release(lock, winner);
    await claim(lock, { token: 'third' });
    assert.equal((await readJson(lock)).token, 'third');
  } finally { await rm(root, { recursive: true, force: true }); }
});
