import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitReady } from '../src/registration.mjs';

const record = { workerId: 'worker', sessionId: 'session',
  sessionFile: '/sessions/worker.jsonl', checkpoint: '/project/checkpoint.md' };

for (const failure of ['fsync', 'close', 'rename']) {
  test(`failed ${failure} cannot expose a ready marker even when cleanup fails`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuation-ready-'));
    const marker = join(root, 'ready-worker.json');
    const io = {
      ...fs,
      fsyncSync(file) {
        if (failure === 'fsync') throw new Error('simulated fsync failure');
        return fs.fsyncSync(file);
      },
      closeSync(file) {
        fs.closeSync(file);
        if (failure === 'close') throw new Error('simulated close failure');
      },
      renameSync(from, to) {
        if (failure === 'rename') throw new Error('simulated rename failure');
        return fs.renameSync(from, to);
      },
      unlinkSync() { throw new Error('simulated cleanup failure'); },
    };
    try {
      assert.throws(() => commitReady(marker, record, io), /simulated/);
      assert.equal(fs.existsSync(marker), false);
      assert.equal((await readdir(root)).length, 1); // Only an inert temporary file remains.
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('successful ready marker matches the exact registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-ready-'));
  const marker = join(root, 'ready-worker.json');
  try {
    commitReady(marker, record);
    assert.deepEqual(JSON.parse(await readFile(marker)), record);
    assert.throws(() => commitReady(marker, record), /already exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
