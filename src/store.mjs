import { mkdir, readFile, rename, open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const defaultRoot = () => join(homedir(), '.pi-continuation');

export async function ensureRoot(root = defaultRoot()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await stat(root);
  if (!info.isDirectory() || (process.platform !== 'win32' &&
    (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error('Continuation state directory must be private to its owner');
  }
  return root;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await replaceFile(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

// Windows can temporarily reject replacement while a reader/scanner holds the
// destination. Retry only the rename of this already-synced snapshot, never the
// operation which produced it (in particular, never a message delivery).
export async function replaceFile(source, destination, {
  platform = process.platform, move = rename, wait = delay,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await move(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5)
        throw error;
      await wait(25 * 2 ** attempt);
    }
  }
}

// Exclusive creation: no second owner may rewrite or 'recover' a live claim.
export async function claim(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path) {
  // Windows cannot open directories for fsync through Node; file sync still applies.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
}

export async function release(path, token) {
  const owner = await readJson(path);
  if (owner.token !== token) throw new Error('Ownership changed; refusing release');
  await rm(path);
}
