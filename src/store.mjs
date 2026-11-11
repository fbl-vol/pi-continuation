import { mkdir, readFile, rename, open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

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
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
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
