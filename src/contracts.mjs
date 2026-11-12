import { join } from 'node:path';
import { readJson } from './store.mjs';

/**
 * Shared durable protocol. Supervisor is the sole writer of scopes, dispositions,
 * budgets, notices and intents; each recipient owns its observations/receipts.
 * Decoding validates representation, never grants live session/owner authority.
 *
 * @typedef {{id: string, file: string, leaf?: string}} SessionIdentity
 * @typedef {{schemaVersion?: number, session: SessionIdentity, outcome: string,
 *   stop: string|null, version?: number, hold?: boolean, bootstrapPending?: boolean,
 *   finalReply?: string, at?: string, promptScope?: {id: string, revision: number}}} Observation
 * @typedef {{sessionId: string, sessionFile: string, paneId: string, cwd: string,
 *   terminalId: string, workspaceId: string, tabId: string,
 *   sessionKind: string, sessionValue: string}} NativeBinding
 * @typedef {NativeBinding & {workerId: string, route: string, checkpoint?: string,
 *   paused: boolean, reason?: string}} WorkerBinding
 * @typedef {{paused: boolean, coordinator?: NativeBinding & {id: string}, reason?: string}} Route
 * @typedef {{id: string, workerId: string, stop?: string, route: string, reportHash?: string,
 *   kind: 'completion'|'blocker'|'decision', text: string,
 *   status: 'pending'|'sending'|'sent'|'stale'|'uncertain'|'resolved'}} Notice
 * @typedef {{id: string, workerId: string, stop: string, ownerToken: string,
 *   status: 'sending'|'rejected'}} Intent
 * @typedef {{id: string, status: 'accepted'|'sent'}} Receipt
 * @typedef {{schemaVersion: number, paused: boolean, ownerToken?: string, ownerPid?: number,
 *   workers: Object<string, WorkerBinding>, routes: Object<string, Route>,
 *   handled: Object<string, string>, resumed: Object<string, string>,
 *   dispositions: Object<string, {stop: string, action: string}>,
 *   budgets: Object<string, {count: number, hash: string, checkpoint: string}>,
 *   repair: Object<string, {stop: string, count: number, noticeId?: string, failure?: string}>,
 *   blocked: Object<string, {stop: string, sequence: number, handled?: boolean}>,
 *   notices: Object<string, Notice>, inflight: Object<string, {id: string, stop: string}>}} SupervisorState
 */

export const SCHEMA_VERSION = 1;
export const MAX_FINAL_REPLY_BYTES = 8192;
export const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw Object.assign(new Error('Invalid continuation record'), { code: 'INVALID_RECORD' }); };

function format(record) {
  if (!object(record)) invalid();
  if (record.schemaVersion === undefined) return 0; // Original unversioned format.
  if (record.schemaVersion !== SCHEMA_VERSION)
    throw Object.assign(new Error('Unsupported continuation record version'), { code: 'UNSUPPORTED_FORMAT' });
  return SCHEMA_VERSION;
}

/** Normalize known legacy records without mutating the caller's retained snapshot. */
export function decodeSupervisor(record) {
  const version = format(record);
  const state = structuredClone(record);
  if (typeof state.paused !== 'boolean' || !object(state.routes) || !object(state.workers)) invalid();
  for (const route of Object.values(state.routes)) {
    if (!object(route) || typeof route.paused !== 'boolean') invalid();
  }
  for (const worker of Object.values(state.workers)) {
    if (!object(worker) || typeof worker.paused !== 'boolean' || typeof worker.route !== 'string') invalid();
  }
  for (const name of ['handled', 'dispositions', 'budgets', 'repair', 'notices', 'inflight']) {
    if (version === 0 && state[name] == null) state[name] = {};
    if (!object(state[name])) invalid();
  }
  // Additive advisory Herdr attention, never a resumable native worker stop.
  if (state.blocked === undefined) state.blocked = {};
  if (!object(state.blocked)) invalid();
  for (const value of Object.values(state.blocked)) {
    if (!object(value) || !isId(value.stop) || !Number.isSafeInteger(value.sequence) ||
        value.sequence < 0 || (value.handled !== undefined && typeof value.handled !== 'boolean')) invalid();
  }
  // Old handled stops did not distinguish acknowledgement from delivery.
  // Their no-resend guard must survive an upgrade, even if it is conservative.
  if (version === 0 && state.resumed == null) state.resumed = { ...state.handled };
  if (!object(state.resumed)) invalid();
  for (const name of ['handled', 'resumed']) {
    if (Object.values(state[name]).some(stop => typeof stop !== 'string')) invalid();
  }
  for (const name of ['dispositions', 'budgets', 'repair', 'notices', 'inflight']) {
    if (Object.values(state[name]).some(value => !object(value))) invalid();
  }
  for (const value of Object.values(state.budgets)) {
    if (!Number.isSafeInteger(value.count) || value.count < 0 || typeof value.hash !== 'string' ||
        (value.checkpoint !== undefined && typeof value.checkpoint !== 'string')) invalid();
  }
  for (const value of Object.values(state.repair)) {
    if (typeof value.stop !== 'string' || !Number.isSafeInteger(value.count) || value.count < 0) invalid();
  }
  for (const value of Object.values(state.inflight)) {
    if (typeof value.id !== 'string' || typeof value.stop !== 'string') invalid();
  }
  for (const value of Object.values(state.dispositions)) {
    if (typeof value.stop !== 'string' ||
        !['resume', 'acknowledge', 'pause', 'completion', 'blocker', 'decision'].includes(value.action)) invalid();
  }
  for (const [id, notice] of Object.entries(state.notices)) {
    if (notice.id !== id || typeof notice.workerId !== 'string' || typeof notice.text !== 'string' ||
        (notice.reportHash !== undefined && (typeof notice.reportHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(notice.reportHash))) ||
        !Object.hasOwn(state.routes, notice.route) ||
        !['completion', 'blocker', 'decision'].includes(notice.kind) ||
        !['pending', 'sending', 'sent', 'stale', 'uncertain', 'resolved'].includes(notice.status)) invalid();
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

export function newSupervisor() {
  return decodeSupervisor({ paused: true, routes: {}, workers: {} });
}

export async function readSupervisor(root) {
  return decodeSupervisor(await readJson(join(root, 'supervisor.json')));
}

export function decodeObservation(record) {
  const version = format(record);
  if (!object(record.session) || typeof record.session.id !== 'string' ||
      typeof record.session.file !== 'string' ||
      !['unknown', 'working', 'completed', 'approval', 'aborted', 'error'].includes(record.outcome) ||
      !(record.stop === null || typeof record.stop === 'string')) invalid();
  if ((version === 1 || record.version !== undefined) &&
      (!Number.isSafeInteger(record.version) || record.version < 0)) invalid();
  if (record.hold !== undefined && typeof record.hold !== 'boolean') invalid();
  if (record.bootstrapPending !== undefined && typeof record.bootstrapPending !== 'boolean') invalid();
  if (record.promptScope !== undefined && (!object(record.promptScope) ||
      !isId(record.promptScope.id) || !Number.isSafeInteger(record.promptScope.revision) ||
      record.promptScope.revision < 0)) invalid();
  if (record.finalReply !== undefined && (typeof record.finalReply !== 'string' ||
      Buffer.byteLength(record.finalReply, 'utf8') > MAX_FINAL_REPLY_BYTES)) invalid();
  // An old completed stop without its final answer cannot be reviewed for a
  // prose-only approval request. Never make missing evidence resumable.
  const replyMissing = record.outcome === 'completed' && !record.finalReply?.trim();
  return { ...record, hold: record.hold !== false || replyMissing ||
    (record.bootstrapPending === true && record.stop !== null) ||
    ['aborted', 'approval', 'error'].includes(record.outcome) };
}

export async function readObservation(root, workerId) {
  return decodeObservation(await readJson(join(root, `observation-${workerId}.json`)));
}
