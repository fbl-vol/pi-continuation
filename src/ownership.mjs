import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { atomicJson, claim, ensureRoot, readJson } from './store.mjs';

const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = message => { throw Object.assign(new Error(`Ownership fence: ${message}`), { code: 'OWNERSHIP_FENCE' }); };
const key = sessionFile => createHash('sha256').update(sessionFile, 'utf8').digest('hex');
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const baseline = async identity => ({ sessionHash: await fileHash(identity.sessionFile),
  checkpointHash: await fileHash(identity.checkpoint) });
const paths = (root, sessionFile) => ({
  record: join(root, `fence-${key(sessionFile)}.json`),
  lock: join(root, `fence-${key(sessionFile)}.lock`),
  standaloneUse: join(root, `used-${key(sessionFile)}.json`),
});
const witnessRoot = async root => join(await realpath(root), 'ownership');

/** Identity is supplied by the selected old binding, never inferred from a pane. */
export async function canonicalIdentity(identity) {
  if (!identity || !uuid(identity.sessionId) ||
      !['sessionFile', 'checkpoint'].every(k => typeof identity[k] === 'string' && isAbsolute(identity[k])))
    fail('invalid worker identity');
  const result = { sessionId: identity.sessionId,
    sessionFile: await realpath(identity.sessionFile), checkpoint: await realpath(identity.checkpoint) };
  for (const path of [result.sessionFile, result.checkpoint]) {
    if (!(await stat(path)).isFile()) fail('identity must name existing files');
  }
  return result;
}

function decode(record) {
  if (!record || record.schemaVersion !== 1 || !uuid(record.handoffId) ||
      !uuid(record.identity?.sessionId) || !uuid(record.target?.workerId) ||
      !['sessionFile', 'checkpoint'].every(k => typeof record.identity?.[k] === 'string' &&
        isAbsolute(record.identity[k])) ||
      typeof record.target?.root !== 'string' || !isAbsolute(record.target.root) ||
      !['prepared', 'owned', 'returning', 'returned'].includes(record.phase) ||
      typeof record.used !== 'boolean' ||
      !['sessionHash', 'checkpointHash'].every(k => typeof record.baseline?.[k] === 'string' &&
        /^[a-f0-9]{64}$/.test(record.baseline[k])))
    fail('invalid or unsupported witness');
  return record;
}

function matches(record, reference) {
  return record.handoffId === reference.handoffId &&
    record.identity.sessionId === reference.identity.sessionId &&
    record.identity.sessionFile === reference.identity.sessionFile &&
    record.identity.checkpoint === reference.identity.checkpoint &&
    record.target.workerId === reference.target.workerId && record.target.root === reference.target.root;
}

/**
 * A shared mkdir mutex works across Node and private adapters without a shell or
 * platform-specific flock API. Never steal a lock, even if its process died:
 * inspect in-flight effects before manually removing an abandoned lock directory.
 * The callback must include the entire external effect, not only an eligibility read.
 */
async function locked(root, sessionFile, operation) {
  await ensureRoot(root);
  const { record, lock } = paths(root, sessionFile);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('worker busy or abandoned lock; inspect before recovery');
    throw error;
  }
  try { return await operation(record); }
  finally { await rmdir(lock); }
}

/**
 * Caller holds the old registry lock until this returns. The old implementation
 * must already fence activation, resume, attention and notices using this same
 * witness path; a receipt alone cannot fence an unmodified old implementation.
 * reserveOld preserves the complete old worker state and pauses only that worker.
 * Failure leaves a prepared witness blocking both owners, never implicit rollback.
 */
export async function prepareHandoff(root, { identity, target }, reserveOld) {
  identity = await canonicalIdentity(identity);
  await ensureRoot(target.root);
  target = { root: await realpath(target.root), workerId: target.workerId };
  if (!uuid(target.workerId)) fail('invalid target worker');
  root = await realpath(await ensureRoot(root));
  if (root !== await witnessRoot(target.root)) fail('witness must use the destination ownership directory');
  return locked(root, identity.sessionFile, async path => {
    try {
      await stat(paths(root, identity.sessionFile).standaloneUse);
      fail('standalone delivery already attempted; reconcile before transfer');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { schemaVersion: 1, handoffId: randomUUID(), identity, target,
      phase: 'prepared', used: false, baseline: await baseline(identity) };
    await claim(path, record);
    await reserveOld(structuredClone(record));
    record.phase = 'owned';
    await atomicJson(path, record);
    return { root, handoffId: record.handoffId, identity, target };
  });
}

/** Read-only preview; absence is not proof that the old supervisor is stopped. */
export async function inspectHandoff(root, sessionFile) {
  return decode(await readJson(paths(root, await realpath(sessionFile)).record));
}

/**
 * Hold the mutex through activation/delivery. Mark effect=true BEFORE any new
 * external effect: even an uncertain/failed delivery forbids automatic rollback.
 * This does not grant activation or replace stop, pause, receipt and approval checks.
 */
export async function withHandoff(reference, { effect = false } = {}, operation) {
  if (!reference || !isAbsolute(reference.root ?? '') ||
      !isAbsolute(reference.identity?.sessionFile ?? '')) fail('invalid handoff reference');
  return locked(reference.root, reference.identity.sessionFile, async path => {
    const record = await ownedWitness(path, reference);
    if (effect && !record.used) {
      record.used = true;
      await atomicJson(path, record);
    }
    return operation(structuredClone(record));
  });
}

async function ownedWitness(path, reference) {
  const record = decode(await readJson(path));
  if (!matches(record, reference) || record.phase !== 'owned') fail('not the selected continuation owner');
  const identity = await canonicalIdentity(reference.identity);
  if (identity.sessionFile !== record.identity.sessionFile || identity.checkpoint !== record.identity.checkpoint)
    fail('canonical identity changed');
  return record;
}

async function workerFence(root, workerId, binding) {
  if (typeof binding?.sessionFile !== 'string') fail('missing session file binding');
  const sessionFile = await realpath(binding.sessionFile);
  const directory = await witnessRoot(root);
  const reference = binding.handoff;
  if (reference !== undefined && (reference?.root !== directory ||
      reference?.target?.workerId !== workerId || reference.target?.root !== await realpath(root) ||
      reference.identity?.sessionId !== binding.sessionId ||
      reference.identity?.sessionFile !== binding.sessionFile ||
      reference.identity?.checkpoint !== binding.checkpoint)) fail('handoff does not match worker binding');
  return { sessionFile, directory, reference };
}

async function requireStandalone(path) {
  try {
    await readJson(path);
    fail('handoff witness exists; attach the exact reference before activation');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Observation only, never permission to deliver. Do not contend with an active effect. */
export async function checkWorkerHandoff(root, workerId, binding) {
  try {
    const { sessionFile, directory, reference } = await workerFence(root, workerId, binding);
    const { record } = paths(directory, sessionFile);
    if (reference === undefined) await requireStandalone(record);
    else await ownedWitness(record, reference);
  } catch (error) { error.code = 'OWNERSHIP_FENCE'; throw error; }
}

/** Bind a witness to this package's exact worker, never just its display identity. */
export async function withWorkerHandoff(root, workerId, binding, options, operation) {
  let entered = false;
  try {
    const { sessionFile, directory, reference } = await workerFence(root, workerId, binding);
    if (reference === undefined) {
      return await locked(directory, sessionFile, async path => {
        // Discovery is mandatory: omitting attachment cannot turn a reserved
        // worker into a standalone worker. The same mutex excludes preparation.
        await requireStandalone(path);
        if (options?.effect) {
          try { await claim(paths(directory, sessionFile).standaloneUse, { used: true }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        entered = true;
        return operation();
      });
    }
    return await withHandoff(reference, options, record => {
      entered = true;
      return operation(record);
    });
  } catch (error) {
    // Keep transport/operation failures distinct from a definite ownership rejection.
    if (!entered) error.code = 'OWNERSHIP_FENCE';
    throw error;
  }
}

/**
 * Caller holds the old registry lock. Restore only the reserved old worker,
 * paused, without overwriting sibling state. The mutex excludes accepted new
 * effects; returning fences the new owner before the old reservation is cleared.
 * A used witness needs manual forward reconciliation, not an old snapshot restore.
 */
export async function rollbackHandoff(reference, restoreOldPaused) {
  if (!reference || !isAbsolute(reference.root ?? '') ||
      !isAbsolute(reference.identity?.sessionFile ?? '')) fail('invalid handoff reference');
  return locked(reference.root, reference.identity.sessionFile, async path => {
    const record = decode(await readJson(path));
    if (!matches(record, reference) || record.used ||
        !['prepared', 'owned', 'returning'].includes(record.phase)) fail('rollback requires unused exact handoff');
    const identity = await canonicalIdentity(record.identity);
    if (identity.sessionFile !== record.identity.sessionFile || identity.checkpoint !== record.identity.checkpoint)
      fail('canonical identity changed');
    const current = await baseline(record.identity);
    if (current.sessionHash !== record.baseline.sessionHash ||
        current.checkpointHash !== record.baseline.checkpointHash)
      fail('worker progressed; reconcile forward instead of restoring old state');
    record.phase = 'returning';
    await atomicJson(path, record);
    await restoreOldPaused(structuredClone(record));
    record.phase = 'returned';
    await atomicJson(path, record);
    return record;
  });
}
