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
 *   sessionKind: string, sessionValue: string, pendingSession?: string}} NativeBinding
 * @typedef {NativeBinding & {workerId: string, route: string, checkpoint?: string,
 *   paused: boolean, reason?: string, role?: 'owner', coordinatorId?: string, displayLabel?: string,
 *   recipient?: NativeBinding & {id: string, role: 'owner'}}} WorkerBinding
 * @typedef {{paused: boolean, coordinator?: NativeBinding & {id: string}, reason?: string}} Route
 * @typedef {{id: string, workerId: string, stop?: string, route: string, reportHash?: string,
 *   recipient?: NativeBinding & {id: string, role: 'owner'},
 *   kind: 'completion'|'blocker'|'decision', text: string,
 *   status: 'pending'|'sending'|'sent'|'stale'|'uncertain'|'resolved'}} Notice
 * @typedef {{id: string, workerId: string, stop: string, ownerToken: string,
 *   status: 'sending'|'rejected'}} Intent
 * @typedef {{id: string, status: 'accepted'|'sent'}} Receipt
 * @typedef {{schemaVersion: number, paused: boolean, ownerToken?: string, ownerPid?: number,
 *   workers: Object<string, WorkerBinding>, routes: Object<string, Route>,
 *   retiredWorkers: Object<string, WorkerBinding & {retiredBy: string}>,
 *   handled: Object<string, string>, resumed: Object<string, string>,
 *   dispositions: Object<string, {stop: string, action: string}>,
 *   budgets: Object<string, {count: number, hash: string, checkpoint: string}>,
 *   repair: Object<string, {stop: string, count: number, noticeId?: string, failure?: string}>,
 *   blocked: Object<string, {stop: string, sequence: number, handled?: boolean}>,
 *   notices: Object<string, Notice>, inflight: Object<string, {id: string, stop: string}>,
 *   ownerWaits: Object<string, {kind: 'child'|'user'|'released', children?: string[], stop?: string|null, id?: string, decisionId?: string}>,
 *   closedAssignments: Object<string, {launchId: string, writerId: string, ownerToken?: string, at: string}>}} SupervisorState
 */

export const SCHEMA_VERSION = 1;
export const MAX_FINAL_REPLY_BYTES = 8192;
export const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw Object.assign(new Error('Invalid continuation record'), { code: 'INVALID_RECORD' }); };

function format(record, supervisor = false) {
  if (!object(record)) invalid();
  if (record.schemaVersion === undefined) return 0; // Original unversioned format.
  if (record.schemaVersion !== SCHEMA_VERSION && !(supervisor && record.schemaVersion === 2))
    throw Object.assign(new Error('Unsupported continuation record version'), { code: 'UNSUPPORTED_FORMAT' });
  return record.schemaVersion;
}

export function validReviewFindings(findings) {
  return Array.isArray(findings) && findings.length > 0 && findings.length <= 10 &&
    findings.every(finding => typeof finding === 'string' && finding.trim() &&
      Buffer.byteLength(JSON.stringify(finding)) <= 3000);
}

export function selectedReviewFinding(text, findings) {
  if (typeof text !== 'string' || !validReviewFindings(findings)) return undefined;
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  const match = /^fix (?:only )?(?:the )?(?:(?:finding |f)(10|[1-9])|([a-z]+)(?: finding)?)(?: only)?[.!]?$/i.exec(text.trim());
  if (!match) return undefined;
  const number = match[1] ? Number(match[1]) : words.indexOf(match[2].toLowerCase()) + 1;
  if (findings[number - 1]) return `Fix finding ${number} only:\n${findings[number - 1]}`;
}

/** Normalize known legacy records without mutating the caller's retained snapshot. */
export function decodeSupervisor(record) {
  const version = format(record, true);
  const state = structuredClone(record);
  if (typeof state.paused !== 'boolean' || !object(state.routes) || !object(state.workers)) invalid();
  if (state.acceptStarts !== undefined && typeof state.acceptStarts !== 'boolean') invalid();
  for (const route of Object.values(state.routes)) {
    if (!object(route) || typeof route.paused !== 'boolean') invalid();
  }
  for (const worker of Object.values(state.workers)) {
    if (!object(worker) || typeof worker.paused !== 'boolean' || typeof worker.route !== 'string') invalid();
    if (worker.stopped !== undefined && (worker.stopped !== true || worker.paused !== true ||
        typeof worker.stoppedPaused !== 'boolean' || !isId(worker.stopToken))) invalid();
    if (worker.stopped === undefined && (worker.stoppedPaused !== undefined || worker.stopToken !== undefined)) invalid();
    if (worker.role !== undefined && (worker.role !== 'owner' || !isId(worker.coordinatorId))) invalid();
    if (worker.recipient !== undefined && (!object(worker.recipient) || !isId(worker.recipient.id) ||
        worker.recipient.role !== 'owner' || !isId(worker.recipient.sessionId) ||
        typeof worker.recipient.sessionFile !== 'string')) invalid();
  }
  for (const name of ['handled', 'dispositions', 'budgets', 'repair', 'notices', 'inflight']) {
    if (version === 0 && state[name] == null) state[name] = {};
    if (!object(state[name])) invalid();
  }
  // Retired bindings remain provenance; they can never be activated or re-added.
  if (state.retiredWorkers === undefined) state.retiredWorkers = {};
  if (!object(state.retiredWorkers)) invalid();
  for (const [id, worker] of Object.entries(state.retiredWorkers)) {
    if (!isId(id) || !object(worker) || worker.workerId !== id || worker.paused !== true ||
        !isId(worker.retiredBy) || typeof worker.sessionId !== 'string' ||
        typeof worker.sessionFile !== 'string' || Object.hasOwn(state.workers, id)) invalid();
  }
  if (state.closedAssignments === undefined) state.closedAssignments = {};
  if (!object(state.closedAssignments)) invalid();
  for (const [id, closed] of Object.entries(state.closedAssignments)) {
    if (!isId(id) || !object(closed) || !isId(closed.launchId) || !isId(closed.writerId) ||
        (closed.ownerToken !== undefined && !isId(closed.ownerToken)) ||
        !Number.isFinite(Date.parse(closed.at))) invalid();
  }
  if (state.ownerWaits === undefined) state.ownerWaits = {};
  if (!object(state.ownerWaits)) invalid();
  for (const [id, wait] of Object.entries(state.ownerWaits)) {
    if (!isId(id) || state.workers[id]?.role !== 'owner' || !object(wait) ||
        !['child', 'user', 'released'].includes(wait.kind) ||
        (wait.kind === 'child' ? !Array.isArray(wait.children) || !wait.children.length ||
          wait.children.some(child => !isId(child)) : wait.children !== undefined) ||
        (wait.kind === 'released' ? !(wait.stop === null || typeof wait.stop === 'string') :
          wait.stop !== undefined) ||
        (wait.id !== undefined && (wait.kind !== 'user' || !isId(wait.id))) ||
        (wait.findings !== undefined && (wait.kind !== 'user' || !wait.id || !validReviewFindings(wait.findings))) ||
        (wait.decisionId !== undefined && (!wait.id || !isId(wait.decisionId)))) invalid();
  }
  // A queue entry is intent only, not evidence that the preceding assignment closed.
  if (state.assignmentQueues === undefined) state.assignmentQueues = {};
  if (!object(state.assignmentQueues)) invalid();
  const queuedIds = new Set();
  for (const [grantId, entries] of Object.entries(state.assignmentQueues)) {
    if (!isId(grantId) || !Array.isArray(entries)) invalid();
    for (const entry of entries) {
      if (!object(entry) || !isId(entry.id) || queuedIds.has(entry.id) ||
          typeof entry.scope !== 'string' || !entry.scope.trim() || Buffer.byteLength(entry.scope) > 8000 ||
          typeof entry.leaf !== 'string' || !entry.leaf || !Number.isFinite(Date.parse(entry.at))) invalid();
      queuedIds.add(entry.id);
    }
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
        (notice.recipient !== undefined && (!object(notice.recipient) || !isId(notice.recipient.id) ||
          notice.recipient.role !== 'owner' || !isId(notice.recipient.sessionId))) ||
        !['completion', 'blocker', 'decision'].includes(notice.kind) ||
        !['pending', 'sending', 'sent', 'stale', 'uncertain', 'resolved', 'archived'].includes(notice.status)) invalid();
    if (notice.unsentRecipient !== undefined && (version !== 2 || notice.kind !== 'blocker' ||
        notice.status !== 'pending' || !object(notice.unsentRecipient) || !isId(notice.unsentRecipient.id))) invalid();
    if (notice.status === 'archived' && (version !== 2 || notice.kind !== 'blocker' || !object(notice.archive) ||
        notice.archive.reason !== 'orphaned-before-send' || !Number.isFinite(Date.parse(notice.archive.at)) ||
        !object(notice.archive.recipient) || !isId(notice.archive.recipient.id) || !isId(notice.archive.launchId))) invalid();
  }
  state.schemaVersion = version || SCHEMA_VERSION;
  return state;
}

// Only an unchanged settled report (or its exact native-command typing witness)
// can identify the current owner decision stop.
export function ownerDecisionEvidence(observed, binding) {
  const report = observed?.hold && observed.holdReason === 'typing' &&
    observed.parkedReport?.stop === observed.commandReport?.stop ? observed.commandReport : observed;
  if (!report?.hold && report?.outcome === 'completed' && report.stop && !observed.bootstrapPending &&
      report.session.id === binding.sessionId && report.session.file === binding.sessionFile &&
      report.session.leaf === observed.session.leaf)
    return { stop: report.stop, leaf: report.session.leaf, version: observed.version };
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
  if (record.holdReason !== undefined &&
      !['typing', 'interruption', 'prompt', 'error', 'restored'].includes(record.holdReason)) invalid();
  if (record.holdError !== undefined) {
    const error = record.holdError;
    if (!object(error) || !['run', 'checkpoint'].includes(error.kind) ||
        typeof error.at !== 'string' || !Number.isFinite(Date.parse(error.at))) invalid();
  }
  if (record.checkpointRecovery !== undefined) {
    const recovery = record.checkpointRecovery;
    const original = recovery?.report;
    if (version !== 1 || record.outcome !== 'error' || record.stop !== null ||
        record.hold !== true || record.holdError?.kind !== 'checkpoint' ||
        !object(recovery) || !/^[a-f0-9]{64}$/.test(recovery.hash) ||
        !object(original) || original.checkpointRecovery !== undefined ||
        original.schemaVersion !== SCHEMA_VERSION || original.outcome !== 'completed' ||
        original.hold !== false || !isId(original.stop) ||
        typeof original.finalReply !== 'string' || !original.finalReply.trim() ||
        original.version !== record.version || original.session?.id !== record.session.id ||
        original.session?.file !== record.session.file || original.session?.leaf !== record.session.leaf ||
        decodeObservation(original).hold) invalid();
  }
  if (record.parkedReport !== undefined) {
    const parked = record.parkedReport;
    if (version !== 1 || !object(parked) || parked.parkedReport !== undefined ||
        parked.schemaVersion !== SCHEMA_VERSION || parked.outcome !== 'approval' || parked.hold !== true ||
        parked.version !== record.version || !['typing', 'interruption'].includes(record.holdReason)) invalid();
    decodeObservation(parked);
  }
  if (record.commandReport !== undefined) {
    const original = record.commandReport;
    if (version !== 1 || record.outcome !== 'unknown' || record.stop !== null ||
        record.hold !== true || record.holdReason !== 'typing' || !object(original) ||
        original.schemaVersion !== SCHEMA_VERSION || original.outcome !== 'completed' ||
        original.hold !== false || !isId(original.stop) || !original.finalReply?.trim() ||
        original.version !== record.version - 1 || original.session?.id !== record.session.id ||
        original.session?.file !== record.session.file || original.session?.leaf !== record.session.leaf ||
        original.commandReport !== undefined || decodeObservation(original).hold) invalid();
  }
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
