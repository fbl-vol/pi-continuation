import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureRoot, claim, release, readJson } from '../src/store.mjs';

const moduleUrl = new URL('../src/store.mjs', import.meta.url).href;
function competitor(lock, token) {
  return new Promise(resolve => {
    const source = `import {claim} from ${JSON.stringify(moduleUrl)}; await claim(process.argv[1], {token:process.argv[2]}).then(()=>process.exit(0),()=>process.exit(2));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, lock, token],
      { stdio: 'ignore' });
    child.on('exit', code => resolve(code));
  });
}

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
