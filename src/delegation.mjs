import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from 'typebox';
import { atomicJson, claim, defaultRoot, ensureRoot, readJson, release } from './store.mjs';
import { isId, newSupervisor, readObservation, readSupervisor } from './contracts.mjs';
import { deliveryFields, reviewFixPreferenceGuidance, readAssignmentDeliveryPreferences,
  readDeliveryPreferences } from './preferences.mjs';
import { currentSession } from './session.mjs';
import { unresolvedDecisionAtStop } from './policy.mjs';
import { agreedLaunchScope, managedCheckpointPath } from './checkpoint.mjs';
import { isSettled, request, sameOccupant, snapshot } from './herdr.mjs';
import { listenJson, ownerAlive, sendAction, supportsAssignmentAbandonment } from './ipc.mjs';

const exec = promisify(execFile);
async function checkoutRoot(cwd) {
  const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
    { timeout: 2500, maxBuffer: 8192, windowsHide: true });
  return realpath(stdout.trim());
}

async function launchCheckout(ctx, scope, select, explicitSpace) {
  const current = await checkoutRoot(ctx.cwd);
  const candidates = new Set([current]);
  const explicit = new Set();
  // Only inspect paths already named by the assignment. The planner's cwd is
  // a default, not a grant to infer a different repository from arbitrary prose.
  const tokens = scope.match(/"[^"]+"|'[^']+'|`[^`]+`|\S+/g) ?? [];
  const namedTokens = [];
  for (const token of tokens) {
    const path = token.replace(/^["'`(]+|["'`),;:.!?]+$/g, '');
    if (!isAbsolute(path)) { namedTokens.push(token); continue; }
    try { explicit.add(await checkoutRoot(path)); }
    catch { refuse('Assignment checkout path cannot be verified; no owner launched'); }
  }
  const names = namedTokens.join(' ').toLowerCase().split(/[^a-z0-9._-]+/i)
    .map(token => token.replace(/[.,;:!?]+$/, ''));
  let base = current;
  for (let depth = 0; depth < 4; depth++) {
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch { break; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !names.includes(entry.name.toLowerCase())) continue;
      try { candidates.add(await checkoutRoot(join(base, entry.name))); } catch { /* not a checkout */ }
    }
    if (dirname(base) === base) break;
    base = dirname(base);
  }
  const named = [...candidates].filter(path => names.includes(basename(path).toLowerCase()));
  const choices = [...new Set([...named, ...explicit])];
  if (!choices.length) choices.push(current);
  if (choices.length === 1) return { checkout: choices[0], space: explicitSpace };
  const offered = explicitSpace ? choices : choices.flatMap(path => [path, `New space · ${path}`]);
  const chosen = await select('Choose the assignment checkout and space', offered);
  if (!chosen || !offered.includes(chosen)) refuse('Checkout selection cancelled; no owner launched');
  return { checkout: chosen.startsWith('New space · ') ? chosen.slice('New space · '.length) : chosen,
    space: chosen.startsWith('New space · ') ? 'new' : explicitSpace ?? 'current' };
}

async function commonDirectory(cwd) {
  const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { timeout: 2500, maxBuffer: 8192, windowsHide: true });
  return realpath(stdout.trim());
}

async function checkoutIdentity(cwd, retained) {
  try {
    const tree = await checkoutRoot(cwd);
    // Existing grants/claims used the common Git directory. Preserve their
    // identity and exclusion while new assignments fence each working tree.
    if (retained && retained !== tree) {
      if (retained === await commonDirectory(cwd)) return retained;
      refuse('Delegation checkout identity changed');
    }
    return tree;
  } catch { refuse('Writer delegation requires a verifiable Git checkout (and Git on PATH)'); }
}

export function delegatedDisplayLabel(role, { scope, checkout }) {
  const prefix = { owner: 'Owner', writer: 'Writer', 'read-only': 'Read-only' }[role];
  // Use the shared grant, never the delegate's message/key. Only a single
  // recognizable task code is safe to take from otherwise private prose.
  const codes = new Set(typeof scope === 'string' ? scope.match(/(?<![\w-])W\d{3}(?:-D\d{2})?(?![\w-])/g) : []);
  const repo = typeof checkout === 'string' ?
    (basename(checkout) === '.git' ? basename(dirname(checkout)) : basename(checkout)) : '';
  const shortRepo = /^[a-z0-9][a-z0-9._-]*$/i.test(repo) ?
    (repo.length > 10 ? `${repo.slice(0, 9)}…` : repo) : '';
  const suffix = codes.size === 1 ? [...codes][0] : shortRepo;
  return suffix ? `${prefix} · ${suffix}` : prefix;
}

async function labelNewPane(transport, socketPath, child, label) {
  // Herdr 0.9.5 has no conditional rename. Inspect the exact current
  // session immediately before the one optional write, never during refresh.
  try {
    const current = await transport(socketPath, 'pane.get', { pane_id: child.paneId }, { timeoutMs: 500 });
    if (current.type === 'pane_info' && !current.pane?.label && sameOccupant(current.pane, child)) {
      await transport(socketPath, 'pane.rename', { pane_id: child.paneId, label }, { timeoutMs: 500 });
    }
  } catch { /* display only; assignment is already delivered, never retry */ }
}

const digest = text => createHash('sha256').update(text).digest('hex');
const refuse = message => { throw new Error(message); };
const recordPath = (root, kind, id) => {
  if (!isId(id)) refuse('Invalid delegation identity');
  return join(root, `${kind}-${id}.json`);
};
export const spawnPath = (root, id) => recordPath(root, 'spawn', id);
const grantPath = (root, id) => recordPath(root, 'delegation', id);

// An ordinary reply can express queue intent, never parallel-launch or closeout authority.
function queueRequest(text) {
  const match = /^put (.+) after (.+)$/i.exec(text?.trim() ?? '');
  if (!match) return undefined;
  const scope = match[1].trim();
  const after = match[2].replace(/[.!]$/, '').trim();
  if (!scope || !after || Buffer.byteLength(scope) > 8000 || Buffer.byteLength(after) > 8000)
    return undefined;
  return { scope, after };
}

export async function enqueueAssignment(root, state, request, live) {
  const { planner, text, leaf, conflict } = request;
  const queued = conflict ? { scope: text } : queueRequest(text);
  const reject = message => ({ accepted: false, message });
  if (!queued || typeof queued.scope !== 'string' || !queued.scope.trim() || Buffer.byteLength(queued.scope) > 8000 ||
      (conflict && (!isId(conflict.grantId) || !isId(conflict.id) || typeof conflict.checkout !== 'string')) || typeof leaf !== 'string' || !leaf || !planner?.sessionId || !planner.sessionFile ||
      state.supervisorSession === planner.sessionId || Object.values(state.workers).some(w =>
        w.sessionId === planner.sessionId || w.sessionFile === planner.sessionFile))
    return reject('Queue work from the exact planning session that started the current assignment');
  try { requireDelegationParent(live, planner); }
  catch { return reject('The exact planning session changed; nothing was queued'); }
  const candidates = [];
  const after = queued.after?.toLowerCase();
  for (const owner of Object.values(state.workers)) {
    if (owner.role !== 'owner' || owner.stopped || !owner.delegationId || !owner.coordinatorId ||
        (conflict && owner.coordinatorId !== conflict.grantId)) continue;
    const attempt = await readJson(spawnPath(root, owner.delegationId));
    const grant = await readJson(grantPath(root, owner.coordinatorId));
    if (attempt.status !== 'dispatched' || attempt.role !== 'owner' || attempt.workerId !== owner.workerId ||
        attempt.grantId !== grant.id || grant.revoked || !grant.ownerLaunch ||
        !isDeepStrictEqual(grant.parent, planner)) continue;
    const title = grant.scope.split('\n', 1)[0].split(':', 1)[0].trim().toLowerCase();
    if (conflict) {
      const claim = await optionalRecord(writerClaimPath(root, conflict.checkout));
      const writer = Object.values(state.workers).find(w => w.delegationId === conflict.id &&
        w.recipient?.id === grant.id && !w.paused && !w.stopped);
      if (grant.checkout === conflict.checkout && claim?.id === conflict.id && claim.grantId === grant.id && writer &&
          sameOccupant(live.agents.find(agent => agent.pane_id === writer.paneId), writer) &&
          sameOccupant(live.agents.find(agent => agent.pane_id === owner.paneId), owner)) candidates.push(grant.id);
    } else if (after === 'this assignment' || after === 'the current assignment' || after === title) candidates.push(grant.id);
  }
  if (candidates.length !== 1) return reject('Name one active assignment started from this planning session; nothing was queued');
  const [grantId] = candidates;
  const queue = state.assignmentQueues[grantId] ?? [];
  const previous = queue.findIndex(entry => entry.leaf === leaf);
  if (previous >= 0) {
    if (queue[previous].scope !== queued.scope) return reject('This planning reply already recorded different work');
    return { accepted: true, position: previous + 1, id: queue[previous].id };
  }
  const entry = { id: randomUUID(), scope: queued.scope, leaf, at: new Date().toISOString() };
  state.assignmentQueues[grantId] = [...queue, entry];
  return { accepted: true, position: queue.length + 1, id: entry.id };
}
export const endedSupervisorPath = (root, token) => recordPath(root, 'supervisor-ended', token);
// Separate, immutable authority: revoking the original grant still revokes recovery.
const reviewerRecoveryPath = (root, recovery) =>
  join(root, `reviewer-recovery-${digest(`${recovery.grantId}\n${recovery.ownerToken}`)}.json`);

async function optionalRecord(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const ownerLaunchPath = (root, checkout) => join(root, `owner-launch-pending-${digest(checkout)}.json`);

async function worktreeForLiveWriter(root, socketPath, state, live, target, scope, ctx, worker, parent, allowed,
  authorizedWorktree, explicitSpace, readyForCreate, queueInstead) {
  const common = await commonDirectory(target);
  const intent = join(root, `owner-worktree-${digest(`${parent.sessionId}\n${common}\n${scope}`)}.json`);
  try {
    const previous = await readJson(intent);
    refuse(`Prior worktree intent at ${previous.path} (${previous.branch}); inspect, do not retry`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const active = [];
  for (const binding of Object.values(state.workers)) {
    if (binding.role === 'owner' || binding.paused || binding.stopped ||
        await checkoutRoot(binding.cwd).catch(() => undefined) !== target) continue;
    const agent = live.agents.find(a => a.pane_id === binding.paneId);
    if (sameOccupant(agent, binding) && ['idle', 'working', 'done', 'blocked'].includes(agent.agent_status))
      active.push(binding);
  }
  if (!active.length && !authorizedWorktree) return { cwd: target, space: explicitSpace ?? 'current' };
  for (const binding of Object.values(state.workers)) {
    if (active.includes(binding)) continue;
    let tree;
    try { tree = await checkoutRoot(binding.cwd); }
    catch { refuse('Existing worker checkout cannot be verified; inspect before creating another worktree'); }
    if (tree !== target) continue;
    const wait = state.ownerWaits[binding.workerId];
    const ownerAgent = live.agents.find(agent => agent.pane_id === binding.paneId);
    const waitingForLiveChildren = wait?.kind === 'child' && sameOccupant(ownerAgent, binding) &&
      isSettled(ownerAgent) && wait.children.every(id => active.some(child => child.workerId === id &&
        child.recipient?.id === binding.coordinatorId && child.recipient.sessionId === binding.sessionId &&
        child.recipient.sessionFile === binding.sessionFile));
    if (binding.role !== 'owner' || binding.paused || (wait && !waitingForLiveChildren) || state.inflight[binding.workerId] ||
        state.dispositions[binding.workerId]?.action === 'decision' ||
        Object.values(state.notices).some(n => n.recipient?.id === binding.coordinatorId && unresolvedNotice(n)))
      refuse('Other checkout registrations need inspection before creating another worktree');
  }
  // An alternate tree is not a way to retry an uncertain owner creation or
  // an unaccounted-for writer claim in the original tree.
  for (const path of new Set([ownerLaunchPath(root, target), ownerLaunchPath(root, common),
    join(root, `owner-launch-${digest(`${target}\n${scope}`)}.json`),
    join(root, `owner-launch-${digest(`${common}\n${scope}`)}.json`)])) {
    try { await readJson(path); refuse('Unresolved owner launch; inspect before choosing another worktree'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let conflict;
  for (const path of new Set([writerClaimPath(root, target), writerClaimPath(root, common)])) {
    let claimRecord;
    try { claimRecord = await readJson(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const holder = active.find(binding => binding.delegationId === claimRecord.id);
    if (!holder) refuse('Writer claim is not accounted for by the live writer; inspect before choosing another worktree');
    if (path === writerClaimPath(root, target) && holder.recipient?.id === claimRecord.grantId && isId(claimRecord.grantId))
      conflict = { ...claimRecord, checkout: target };
  }
  const base = (await exec('git', ['-C', target, 'rev-parse', '--verify', 'HEAD'],
    { timeout: 2500, maxBuffer: 8192, windowsHide: true })).stdout.trim();
  const code = scope.match(/(?<![\w-])W\d{3}(?:-D\d{2})?(?![\w-])/i)?.[0]?.toLowerCase() ?? 'assignment';
  const suffix = randomUUID().slice(0, 8);
  const branch = authorizedWorktree?.branch ?? `work/${code}-${suffix}`;
  const path = authorizedWorktree?.path ?? join(dirname(target), `${basename(target)}-${code}-${suffix}`);
  let space = explicitSpace ?? 'current';
  if (authorizedWorktree) {
    if (authorizedWorktree.repository !== target || authorizedWorktree.base !== base ||
        !isAbsolute(path) || !branch) refuse('Authorized worktree does not match the exact repository/base/path');
  } else {
    const canQueue = queueInstead && conflict;
    const title = `${canQueue ? 'This working tree already has a writer. Queue the work or authorize a separate tree.' : 'Create a separate worktree for this assignment?'}\nRepository: ${target}\n` +
      `Base: ${base}\nBranch: ${branch}\nPath: ${path}`;
    const choices = explicitSpace ? ['Create this worktree', 'Cancel'] :
      ['Create in current space', 'Create in new space', ...(canQueue ? ['Queue after the current assignment'] : []), 'Cancel'];
    const choice = await worker.selectManagement(ctx, title, choices);
    if (canQueue && choice === 'Queue after the current assignment' && choices.includes(choice)) {
      if (!allowed() || !sameSession(currentSession(ctx), parent)) refuse('Planning session changed; nothing was queued');
      await queueInstead(conflict);
      return undefined;
    }
    if (!choice?.startsWith('Create') || !choices.includes(choice))
      refuse('Worktree choice cancelled; no owner launched');
    if (choice === 'Create in new space') space = 'new';
  }
  if (!allowed() || !sameSession(currentSession(ctx), parent)) refuse('Planning session changed; no worktree created');
  // The create-or-cancel selection is the user's authorization. Resume the
  // supervisor before claiming the intent or creating Git state; rejection
  // must not strand a worktree or an uncertain-effect claim.
  await readyForCreate();
  if (!allowed() || !sameSession(currentSession(ctx), parent)) refuse('Planning session changed; no worktree created');
  requireDelegationParent(await snapshot(socketPath), parent);
  // Claim before the Git effect. A lost response must never create a second
  // worktree for the same assignment by changing the generated branch/path.
  try { await claim(intent, { target, base, branch, path, parent: parent.sessionId }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(intent);
    refuse(`Prior worktree intent at ${previous.path} (${previous.branch}); inspect, do not retry`);
  }
  try {
    await exec('git', ['-C', target, 'worktree', 'add', '-b', branch, path, base],
      { timeout: 30000, maxBuffer: 8192, windowsHide: true });
  } catch (error) { refuse(`Worktree creation uncertain at ${path} (${error.message}); inspect before retrying`); }
  if (await checkoutRoot(path) !== await realpath(path)) refuse(`New worktree identity changed at ${path}`);
  return { cwd: path, space };
}

async function claimOwnerLaunch(path, id, recovering = false) {
  try { await claim(path, { token: id }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pending = await readJson(path).catch(() => undefined);
    if (recovering && pending?.token === id) return;
    const attempt = isId(pending?.token) ? ` ${pending.token}` : '';
    refuse(`Unresolved owner launch${attempt} for this checkout; inspect before starting another`);
  }
}
const sameSession = (session, binding) => session.id === binding.sessionId && session.file === binding.sessionFile;

function launchOptions(input) {
  if (!input.startsWith('--options ')) return { assignment: input };
  const end = input.indexOf(' -- ');
  if (end < 0) refuse('Use --options <JSON> -- <agreed assignment>');
  let options;
  try { options = JSON.parse(input.slice('--options '.length, end)); }
  catch { refuse('Invalid launch options JSON'); }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['worktree', 'space', 'closeAssignment'].includes(key)) ||
      (options.closeAssignment !== undefined && !isId(options.closeAssignment)) ||
      (options.space !== undefined && !['current', 'new'].includes(options.space)) ||
      (options.worktree !== undefined && (!options.worktree ||
        ['repository', 'base', 'branch', 'path'].some(key => typeof options.worktree[key] !== 'string'))))
    refuse('Invalid launch placement options');
  return { ...options, assignment: input.slice(end + 4).trim() };
}

function nativeBinding(agent, session, cwd) {
  const binding = { paneId: agent?.pane_id, terminalId: agent?.terminal_id,
    workspaceId: agent?.workspace_id, tabId: agent?.tab_id, cwd,
    sessionId: session.id, sessionFile: session.file, sessionKind: 'path', sessionValue: session.file };
  if (!session.id || !session.file || !binding.terminalId || !binding.workspaceId ||
      !sameOccupant(agent, binding)) refuse('Exact native Pi/Herdr session identity required');
  return binding;
}

export function requireDelegationParent(live, parent, recovery = false) {
  const agent = live.agents.find(a => a.pane_id === parent?.paneId);
  if (!sameOccupant(agent, parent) || !['idle', 'working', 'done'].includes(agent.agent_status))
    refuse('Parent Herdr identity/status changed or blocked');
  if (recovery && live.agents.filter(a => a.agent_session?.kind === parent.sessionKind &&
      a.agent_session.value === parent.sessionValue).length !== 1)
    refuse('Competing Herdr occupancy for assignment owner');
}

export async function delegationOwner(root, grant) {
  const state = await readSupervisor(root);
  if (!state.acceptStarts || state.ownerToken !== grant.ownerToken ||
      state.supervisorSession !== grant.supervisorSession || !await ownerAlive(root, grant.ownerToken))
    refuse('Intended running supervisor changed or is unavailable; no replacement will be created');
  if (state.paused) refuse('Global continuation is paused');
  return state;
}

async function provedSupervisorEnd(root, token, sessionId) {
  if (!isId(token) || typeof sessionId !== 'string' || !sessionId) return false;
  const ended = await optionalRecord(endedSupervisorPath(root, token));
  return ended?.token === token && ended.sessionId === sessionId && !await ownerAlive(root, token);
}

async function reviewerRecovery(root, grant, parent, state, preview) {
  if (!isId(state.ownerToken) || state.ownerToken === grant.ownerToken)
    refuse('No replacement supervisor to recover reviewer delegation to');
  const predecessor = state.predecessorSupervisor;
  const recovery = { grantId: grant.id, spawnId: parent.id, workerId: parent.workerId,
    previousToken: grant.ownerToken, previousSession: grant.supervisorSession, predecessor,
    ownerToken: state.ownerToken, supervisorSession: state.supervisorSession, role: 'read-only' };
  if (!preview && !isDeepStrictEqual(await optionalRecord(reviewerRecoveryPath(root, recovery)), recovery))
    refuse('Intended running supervisor changed or is unavailable; in the exact owner use /continuation-delegate recover-reviewers');
  if (!await provedSupervisorEnd(root, grant.ownerToken, grant.supervisorSession))
    refuse('Prior supervisor has no proved graceful end for this assignment');
  if (predecessor?.token === state.ownerToken ||
      !await provedSupervisorEnd(root, predecessor?.token, predecessor?.sessionId))
    refuse('Predecessor supervisor has no proved graceful end for this replacement');
  const lock = await optionalRecord(join(root, 'supervisor.lock'));
  if (lock?.token !== state.ownerToken || lock?.sessionId !== state.supervisorSession || lock?.pid !== state.ownerPid ||
      await optionalRecord(join(root, 'supervisor-start-pending.json')))
    refuse('Replacement supervisor ownership or startup is unresolved');
  const receipt = await optionalRecord(join(root, `spawn-receipt-${parent.id}.json`));
  if (parent.ownerToken !== grant.ownerToken || receipt?.id !== parent.id || receipt?.status !== 'sent')
    refuse('Exact assignment owner dispatch receipt or original authority is unavailable');
  await delegationOwner(root, state);
  let healthy;
  try { healthy = (await sendAction(root, { type: 'reviewer-recovery-health', ownerToken: state.ownerToken,
    sessionId: state.supervisorSession }, 'supervisor')).healthy; }
  catch { /* A missing or older endpoint is not a health witness. */ }
  if (healthy !== true) refuse('Replacement supervisor is not healthy for reviewer recovery');
  return recovery;
}

export async function delegationAuthority(root, reference, binding, commandEvidence, previewRecovery = false) {
  const grant = await readJson(grantPath(root, reference?.grantId));
  if (grant.revoked || (reference.spawnId ? grant.cwd : grant.originCwd ?? grant.cwd) !== await realpath(binding.cwd))
    refuse('Delegation scope revoked or cwd changed');
  let role = grant.role;
  if (!['writer', 'read-only'].includes(role)) refuse('Delegation has no explicit role boundary');
  let inheritedRecipient, launchAttempt;
  if (reference.spawnId) {
    const parent = await readJson(spawnPath(root, reference.spawnId));
    const launchOwner = grant.ownerLaunch && parent.role === 'owner';
    if (parent.grantId !== grant.id || (grant.ownerLaunch ? !launchOwner : !['writer', 'read-only'].includes(parent.role)) ||
        parent.status !== 'dispatched' || JSON.stringify(parent.child) !== JSON.stringify(binding))
      refuse('Subdelegation parent is not the dispatched exact child with delegation authority');
    role = launchOwner ? 'writer' : grant.role === 'read-only' ? 'read-only' : parent.role;
    inheritedRecipient = parent.recipient;
    if (launchOwner && parent.id === reference.spawnId && grant.id === reference.grantId) launchAttempt = parent;
  } else if (JSON.stringify(grant.parent) !== JSON.stringify(binding)) refuse('Delegation belongs to another planning session');
  if (previewRecovery && !launchAttempt) refuse('Reviewer recovery requires the exact launched coordinating owner');
  let state, recovery;
  if (launchAttempt) {
    const current = await readSupervisor(root);
    if (previewRecovery || current.ownerToken !== grant.ownerToken) {
      recovery = await reviewerRecovery(root, grant, launchAttempt, current, previewRecovery);
      state = current;
      role = 'read-only';
    }
  }
  state ??= await delegationOwner(root, grant);
  if (state.routes[binding.workspaceId]?.paused) refuse('Delegation route is paused');
  // A planning session may occupy a historical pane. The checkout check,
  // not a pane-only match, decides whether that prior binding blocks launch.
  const worker = Object.values(state.workers).find(w => w.sessionId === binding.sessionId ||
    (!(grant.ownerLaunch && !reference.spawnId) && w.paneId === binding.paneId));
  const recipient = inheritedRecipient ?? worker?.recipient;
  if (inheritedRecipient && (!worker || worker.recipient?.id !== inheritedRecipient.id))
    refuse('Inherited owner recipient changed; no delegation through this tree');
  if (recipient) {
    const owner = Object.values(state.workers).find(w => w.role === 'owner' &&
      w.coordinatorId === recipient.id && w.sessionId === (worker?.recipient?.sessionId));
    if (!owner) refuse('Assignment owner unavailable; no delegation through this tree');
    if (['user', 'released'].includes(state.ownerWaits?.[owner.workerId]?.kind))
      refuse('Owner is waiting for a user decision; no delegation through this gate');
  }
  if (worker?.role === 'owner' && ['user', 'released'].includes(state.ownerWaits?.[worker.workerId]?.kind))
    refuse('Owner is waiting for a user decision; no delegation through this gate');
  if (grant.ownerLaunch) {
    // The same native owner session can remain live after assignment closeout.
    // Do not let a retained A attempt borrow the authority of B's binding.
    if (reference.spawnId && (worker?.role !== 'owner' || worker.coordinatorId !== grant.id ||
        worker.delegationId !== launchAttempt?.id)) refuse('Exact supervised coordinating owner assignment required');
    if (!reference.spawnId && (state.supervisorSession === binding.sessionId ||
      Object.values(state.workers).some(w => (w.sessionId === binding.sessionId || w.sessionFile === binding.sessionFile) &&
        !(w.role === 'owner' && grant.closeAssignment === w.coordinatorId &&
          ['paneId', 'terminalId', 'workspaceId', 'tabId', 'sessionId', 'sessionFile', 'cwd']
            .every(key => binding[key] === w[key])))))
      refuse('Launch requires an unsupervised planner or the exact closing owner');
  }
  if (recovery && (worker?.workerId !== recovery.workerId || worker.delegationId !== recovery.spawnId ||
      worker.coordinatorId !== grant.id || Object.values(state.workers).filter(w => w.role === 'owner' &&
        (w.coordinatorId === grant.id || w.sessionId === binding.sessionId || w.sessionFile === binding.sessionFile)).length !== 1))
    refuse('Exact surviving assignment owner binding is missing or competing');
  if (recovery && (state.ownerWaits[worker.workerId] || state.dispositions[worker.workerId]?.action === 'decision'))
    refuse('Assignment owner has an unresolved wait or decision');
  if (worker) {
    const observation = await readObservation(root, worker.workerId);
    if (['paneId', 'terminalId', 'workspaceId', 'tabId', 'sessionId', 'sessionFile', 'cwd']
      .some(key => binding[key] !== worker[key])) refuse('Parent worker identity changed');
    const typedControl = (previewRecovery || (grant.ownerLaunch && !reference.spawnId && worker.role === 'owner' &&
      grant.closeAssignment === worker.coordinatorId)) && typedOwnerReport(observation, worker, commandEvidence);
    if (worker.paused || (recovery && (state.routes[worker.route]?.paused || observation.bootstrapPending)) ||
        (observation.hold && !typedControl) || observation.session.id !== binding.sessionId ||
        observation.session.file !== binding.sessionFile) refuse('Parent worker or route is paused or held');
  }
  return { grant, state, role, recovery, ownerToken: state.ownerToken };
}

/** Independent owner-side validation. A worker's request is not a blanket opt-in. */
export async function delegatedStart(root, id, record, state, live) {
  const spawn = await readJson(spawnPath(root, id));
  const grant = await readJson(grantPath(root, spawn.grantId));
  const launchOwner = spawn.role === 'owner';
  if (spawn.id !== id || spawn.grantId !== grant.id ||
      (launchOwner ? !grant.ownerLaunch || spawn.authority?.spawnId || spawn.task !== grant.scope ||
        record.role !== 'owner' || record.coordinatorId !== grant.id :
        !['writer', 'read-only'].includes(spawn.role) || record.role === 'owner' ||
        (grant.ownerLaunch && !spawn.authority?.spawnId)) ||
      spawn.status !== 'enrolling' || grant.revoked || spawn.ownerToken !== state.ownerToken ||
      record.sessionId !== spawn.child?.sessionId || record.sessionFile !== spawn.child?.sessionFile ||
      record.paneId !== spawn.child?.paneId || record.cwd !== grant.cwd ||
      record.start?.nonce !== spawn.id || record.delegationId !== spawn.id || state.paused ||
      state.routes[spawn.child.workspaceId]?.paused || !sameOccupant(live.agents.find(a => a.pane_id === record.paneId), spawn.child))
    refuse('Delegated enrollment is not the newly created exact child under its active owner/scope');
  const authority = await delegationAuthority(root, spawn.authority, spawn.parent);
  requireDelegationParent(live, spawn.parent, !!authority.recovery);
  if (authority.grant.id !== spawn.grantId || authority.ownerToken !== spawn.ownerToken ||
      (authority.recovery ? spawn.role !== 'read-only' : spawn.role === 'writer' && authority.role === 'read-only'))
    refuse('Delegated enrollment exceeds inherited scope');
  if (authority.recovery) await requireSettledRecoveryEffects(root, authority, id);
  if (Object.values(state.workers).some(w => w.paneId === record.paneId || w.sessionId === record.sessionId))
    refuse('Delegated enrollment cannot replace or reactivate an existing worker');
  if (spawn.recipient && (!state.workers[spawn.parentWorkerId] ||
      state.workers[spawn.parentWorkerId].recipient?.id !== spawn.recipient.id &&
      state.workers[spawn.parentWorkerId].coordinatorId !== spawn.recipient.id))
    refuse('Delegated owner recipient changed');
  return { ...spawn, displayLabel: delegatedDisplayLabel(spawn.role, grant) };
}

const unresolvedNotice = notice => ['pending', 'sending', 'uncertain'].includes(notice.status);

// Only a writer's recorded no-effect preflight refusal is settled here; it
// remains a retained attempt and this classification never authorizes retry.
async function settledWriterPreflight(root, attempt, grant, recovery, owner) {
  if (attempt.status !== 'preflight-refused' || attempt.role !== 'writer' ||
      attempt.grantId !== grant.id || attempt.authority?.grantId !== grant.id ||
      attempt.authority.spawnId !== recovery.spawnId || attempt.parentWorkerId !== recovery.workerId ||
      attempt.ownerToken !== grant.ownerToken || attempt.recipient?.id !== grant.id ||
      !sameSession({ id: attempt.parent?.sessionId, file: attempt.parent?.sessionFile }, owner) ||
      !['paneId', 'terminalId', 'workspaceId', 'tabId', 'cwd'].every(key => attempt.parent[key] === owner[key]) ||
      ![undefined, false].includes(attempt.paneRequested) || attempt.paneId || attempt.child || attempt.workerId ||
      attempt.terminalId || attempt.workspaceId || attempt.tabId || attempt.closeRequested || attempt.abandonRequested ||
      !attempt.failure || attempt.preflightFailures?.at(-1)?.reason !== attempt.failure ||
      typeof attempt.key !== 'string' || typeof attempt.task !== 'string') return false;
  for (const [kind, value] of [['key', attempt.key], ['assignment', attempt.task]]) {
    const index = await optionalRecord(join(root, `spawn-${kind}-${digest(`${grant.id}\n${value}`)}.json`));
    if (index?.id !== attempt.id) return false;
  }
  if (await optionalRecord(join(root, `spawn-receipt-${attempt.id}.json`)) !== undefined) return false;
  const fence = await optionalRecord(ownerLaunchPath(root, grant.checkout));
  if (fence?.token === attempt.id) return false;
  for (const checkout of new Set([grant.checkout, await commonDirectory(grant.cwd)])) {
    const writer = await optionalRecord(writerClaimPath(root, checkout));
    if (writer?.id === attempt.id) return false;
  }
  return true;
}

async function requireSettledRecoveryEffects(root, { grant, state, recovery }, currentAttempt) {
  const workers = new Set([recovery.workerId, ...Object.values(state.workers)
    .filter(w => w.recipient?.id === grant.id).map(w => w.workerId)]);
  for (const id of workers) {
    if (state.inflight[id] || state.ownerWaits[id] || state.dispositions[id]?.action === 'decision')
      refuse(`Assignment worker ${id} has an unresolved resume, wait or decision`);
  }
  for (const notice of Object.values(state.notices)) {
    if ((workers.has(notice.workerId) || notice.recipient?.id === grant.id) && unresolvedNotice(notice))
      refuse(`Assignment notice ${notice.id} is unresolved`);
  }
  for (const file of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const attempt = await readJson(join(root, file));
    if (file === `spawn-${currentAttempt}.json`) continue;
    if (attempt.grantId !== grant.id && !workers.has(attempt.workerId) && !workers.has(attempt.parentWorkerId)) continue;
    if (file === `spawn-${attempt.id}.json`) {
      if (attempt.status === 'dispatched') {
        const receipt = await optionalRecord(join(root, `spawn-receipt-${attempt.id}.json`));
        if (receipt?.id === attempt.id && receipt.status === 'sent') continue;
      }
      if (await settledWriterPreflight(root, attempt, grant, recovery, state.workers[recovery.workerId])) continue;
    }
    refuse(`Assignment startup ${file} has no proved dispatch or no-effect preflight`);
  }
}

function exactSessionReference(binding) {
  return ['paneId', 'terminalId', 'workspaceId', 'tabId', 'sessionId', 'sessionFile', 'cwd']
    .every(key => typeof binding[key] === 'string' && binding[key].length > 0) &&
    binding.sessionKind === 'path' && binding.sessionValue === binding.sessionFile;
}

// Absence requires both a targeted pane result and consistent global views.
// A live old session anywhere, a shell, or a changing/partial identity is not absence.
function historicalPane(binding, view) {
  if (!exactSessionReference(binding)) return undefined;
  const oldValues = [binding.sessionFile, binding.sessionId];
  const matchesOld = row => oldValues.includes(row.agent_session?.value);
  if (!Array.isArray(view.panes) || [...view.agents, ...view.panes].some(matchesOld)) return undefined;
  const agents = view.agents.filter(a => a.pane_id === binding.paneId);
  const panes = view.panes.filter(a => a.pane_id === binding.paneId);
  if (!agents.length && !panes.length) return null;
  if (agents.length !== 1 || panes.length !== 1) return undefined;
  const agent = agents[0];
  const value = agent.agent_session?.value;
  if (typeof value !== 'string' || !value || !agent.terminal_id || !agent.workspace_id || !agent.tab_id ||
      !(agent.foreground_cwd || agent.cwd)) return undefined;
  const replacement = { paneId: agent.pane_id, terminalId: agent.terminal_id,
    workspaceId: agent.workspace_id, tabId: agent.tab_id, cwd: agent.foreground_cwd || agent.cwd,
    sessionKind: 'path', sessionValue: value };
  if (sameOccupant(agent, replacement) && sameOccupant(panes[0], replacement)) return replacement;
}

async function absentSession(binding, live, readPane, readSnapshot) {
  const first = historicalPane(binding, live);
  if (first === undefined) return false;
  let pane;
  try {
    const result = await readPane(binding.paneId);
    if (result.type !== 'pane_info') return false;
    pane = result.pane;
  } catch (error) {
    if (error.code !== 'pane_not_found') throw error;
    pane = null;
  }
  if (first === null ? pane !== null : !sameOccupant(pane, first)) return false;
  return isDeepStrictEqual(first, historicalPane(binding, await readSnapshot()));
}

async function historicalWorkerBlocker(root, worker, state, live, readPane, readSnapshot, pending) {
  const id = worker.workerId;
  if (!worker.paused || !isId(id) || state.workers[id] !== worker) return 'not a validated paused binding';
  if (state.ownerWaits[id] || state.dispositions[id]?.action === 'decision') return 'unresolved owner wait or decision';
  if (state.inflight[id]) return `unresolved resume ${state.inflight[id].id}`;
  const notices = Object.values(state.notices).filter(n =>
    (n.workerId === id || (worker.role === 'owner' && n.recipient?.id === worker.coordinatorId)) && unresolvedNotice(n));
  if (notices.some(n => !pending || n.workerId !== id || n.kind !== 'blocker' || n.status !== 'pending' || !n.unsentRecipient))
    return `unresolved ${notices.map(n => `${n.status} notice ${isId(n.id) ? n.id : '(invalid ID)'}`).join(', ')}`;
  try {
    const saved = await readJson(join(root, `worker-${id}.json`));
    if (!registrationMatches(saved, worker) || await realpath(saved.checkpoint) !== worker.checkpoint)
      return 'retained registration does not match';
    if (worker.delegationId) {
      const attempt = await readJson(spawnPath(root, worker.delegationId));
      if (attempt.id !== worker.delegationId || attempt.workerId !== id || attempt.status !== 'dispatched')
        return `unresolved delegated startup ${worker.delegationId}`;
    }
    const observed = await readObservation(root, id).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (observed && !sameSession(observed.session, worker)) return 'observation mismatch';
    if (observed?.bootstrapPending) return 'unfinished startup';
    if (observed?.outcome === 'approval') return 'saved approval remains unanswered';
    if (!await absentSession(worker, live, readPane, readSnapshot)) return 'exact session live or absence unverified';
  } catch { return 'historical binding evidence unavailable'; }
  for (const notice of notices) pending.set(notice.id, notice);
  return null;
}

async function retainedIndependentCheckout(root, worker, target, state, live, readPane, readSnapshot) {
  if (!worker.delegationId || !worker.paused || !await absentSession(worker, live, readPane, readSnapshot) ||
      !await noRelatedStartup(root, [worker])) return false;
  const attempt = await readJson(spawnPath(root, worker.delegationId));
  const grant = await readJson(grantPath(root, attempt.grantId));
  const saved = await readJson(join(root, `worker-${worker.workerId}.json`));
  const child = attempt.child;
  if (attempt.status !== 'dispatched' || attempt.workerId !== worker.workerId ||
      grant.cwd !== worker.cwd || !registrationMatches(saved, worker) ||
      child?.sessionId !== worker.sessionId || child.sessionFile !== worker.sessionFile ||
      child.paneId !== worker.paneId || child.cwd !== worker.cwd ||
      unresolvedWorkerEffects(state, worker.workerId)) return false;
  return grant.checkout !== target && grant.checkout !== await commonDirectory(target);
}

function unresolvedWorkerEffects(state, id) {
  return !!state.inflight[id] || !!state.ownerWaits[id] ||
    state.dispositions[id]?.action === 'decision' ||
    Object.values(state.notices).some(n => n.workerId === id && unresolvedNotice(n));
}

async function inspectCheckout(root, grant, parent, recipient, state, live, readPane, readSnapshot, recover, approvals) {
  if (!grant.checkout || await checkoutIdentity(grant.cwd, grant.checkout) !== grant.checkout)
    refuse('Delegation checkout identity changed');
  const pending = recover ? new Map() : undefined;
  const legacyGrant = grant.checkout !== await checkoutRoot(grant.cwd);
  for (const worker of Object.values(state.workers)) {
    const id = isId(worker.workerId) ? worker.workerId : '(invalid ID)';
    let checkout;
    try { checkout = legacyGrant ? await commonDirectory(worker.cwd) : await checkoutRoot(worker.cwd); }
    catch {
      try {
        if (await retainedIndependentCheckout(root, worker, grant.cwd, state, live, readPane, readSnapshot)) continue;
      } catch { /* Retained evidence is unavailable or contradictory. */ }
      refuse(`Existing worker checkout cannot be verified for ${id}; inspect writer ownership`);
    }
    if (checkout !== grant.checkout) continue;
    const parentOwner = worker.role === 'owner' && worker.coordinatorId &&
      worker.sessionId === parent.sessionId && worker.sessionFile === parent.sessionFile &&
      worker.paneId === parent.paneId && recipient?.id === worker.coordinatorId;
    if (!parentOwner) {
      // A different active owner is a notice recipient, not a source writer.
      // Do not ignore an uncertain owner or an unresolved effect.
      if (worker.role === 'owner' && !worker.paused && !state.ownerWaits[id] && !state.inflight[id] &&
          state.dispositions[id]?.action !== 'decision' &&
          !Object.values(state.notices).some(n => n.recipient?.id === worker.coordinatorId && unresolvedNotice(n)) &&
          sameOccupant(live.agents.find(a => a.pane_id === worker.paneId), worker)) {
        const saved = await readJson(join(root, `worker-${id}.json`));
        if (registrationMatches(saved, worker)) continue;
      }
      const blocker = await historicalWorkerBlocker(root, worker, state, live, readPane, readSnapshot, pending);
      if (blocker === 'saved approval remains unanswered' && approvals &&
          await absentSession(worker, live, readPane, readSnapshot) &&
          await noRelatedStartup(root, [worker])) {
        approvals.push(id);
        continue;
      }
      if (blocker) refuse(`Checkout already has a supervised worker ${id}: ${blocker}; inspect writer ownership`);
    }
  }
  if (approvals?.length && pending.size)
    refuse('Other checkout notices need disposition before historical approval abandonment');
  return pending;
}

const writerClaimPath = (root, checkout) => join(root, `delegation-writer-${digest(checkout)}.json`);

const closeoutScopePath = (root, checkout, scope) => join(root, `owner-launch-${digest(`${checkout}\n${scope}`)}.json`);

function confirmedRetryAbandonment(grant, attempt) {
  const choice = grant.confirmedRetryAbandonment;
  return choice && attempt.status === 'preflight-refused' && !attempt.closeRequested &&
    !attempt.abandonRequested && attempt.paneRequested !== true && !attempt.paneId && !attempt.child &&
    choice.launchId === attempt.id && grant.abandonAssignment === true && isId(grant.closeAssignment) &&
    isId(choice.writerId) && Array.isArray(choice.workerIds) && choice.workerIds.length &&
    choice.workerIds.every(isId);
}

const abandonmentSelection = candidate => ({ writerId: candidate.claim.id,
  workerIds: candidate.bindings.map(w => w.workerId).sort() });
const matchesAbandonmentSelection = (choice, candidate) =>
  isDeepStrictEqual({ writerId: choice.writerId, workerIds: choice.workerIds }, abandonmentSelection(candidate));

// A proved pre-pane refusal may keep its original scope/key across a healthy
// supervisor replacement. Persist the new grant owner first; a lost response
// between writes can then reconcile the same exact attempt on the next call.
async function recoverPreflight(root, checkout, scope, parent, state) {
  let scoped;
  try { scoped = await readJson(closeoutScopePath(root, checkout, scope)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const grant = await readJson(grantPath(root, scoped.grantId));
  const keyed = await readJson(join(root, `spawn-key-${digest(`${grant.id}\nassignment-owner`)}.json`));
  const attempt = await readJson(spawnPath(root, keyed.id));
  if (!grant.ownerLaunch || grant.checkout !== checkout || grant.scope !== scope ||
      !isDeepStrictEqual(grant.parent, parent) || grant.revoked || grant.worktreeCreated ||
      attempt.id !== keyed.id || attempt.grantId !== grant.id || attempt.task !== scope ||
      attempt.role !== 'owner' || attempt.status !== 'preflight-refused' ||
      attempt.paneRequested === true || attempt.paneId || attempt.child ||
      attempt.closeRequested || attempt.abandonRequested) return;
  try {
    const fence = await readJson(ownerLaunchPath(root, checkout));
    if (fence.token !== attempt.id || !confirmedRetryAbandonment(grant, attempt))
      refuse('Unresolved owner launch fence before preflight recovery');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (grant.ownerToken === state.ownerToken && grant.supervisorSession === state.supervisorSession &&
      attempt.ownerToken === state.ownerToken) return { grant, attempt };
  const lineage = grant.rebindTokens ?? [attempt.ownerToken];
  if (!Array.isArray(lineage) || !lineage.length || lineage.at(-1) !== grant.ownerToken ||
      !lineage.includes(attempt.ownerToken) || !lineage.every(isId) ||
      new Set(lineage).size !== lineage.length ||
      (lineage.includes(state.ownerToken) && grant.ownerToken !== state.ownerToken))
    refuse('Prior preflight supervisor ownership is unresolved');
  for (const token of lineage) if (token !== state.ownerToken && await ownerAlive(root, token))
    refuse('Prior preflight supervisor ownership is unresolved');
  if (grant.ownerToken !== state.ownerToken) {
    grant.rebindTokens = [...lineage, state.ownerToken];
    grant.ownerToken = state.ownerToken;
    grant.supervisorSession = state.supervisorSession;
    await atomicJson(grantPath(root, grant.id), grant);
  }
  attempt.ownerToken = state.ownerToken;
  await atomicJson(spawnPath(root, attempt.id), attempt);
  return { grant, attempt };
}

// Only a closeout recorded by this exact B launch may resume a pre-pane attempt.
async function recordedCloseout(root, checkout, scope, parent, state) {
  let scoped;
  try { scoped = await readJson(closeoutScopePath(root, checkout, scope)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const grant = await readJson(grantPath(root, scoped.grantId));
  if (!grant.closeAssignment || !state.closedAssignments?.[grant.closeAssignment]) return;
  const keyed = await readJson(join(root, `spawn-key-${digest(`${grant.id}\nassignment-owner`)}.json`));
  const attempt = await readJson(spawnPath(root, keyed.id));
  const closed = state.closedAssignments?.[grant.closeAssignment];
  let fence;
  try { fence = await readJson(ownerLaunchPath(root, checkout)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fence && fence.token !== attempt.id) refuse('Another launch owns the checkout fence');
  if (!grant.ownerLaunch || grant.worktreeCreated || grant.checkout !== checkout || grant.scope !== scope ||
      !isDeepStrictEqual(grant.parent, parent) ||
      attempt.id !== keyed.id || attempt.grantId !== grant.id || attempt.task !== scope ||
      attempt.role !== 'owner' || !isDeepStrictEqual(attempt.parent, parent) ||
      !attempt.closeRequested || attempt.paneRequested !== false || attempt.paneId || attempt.child ||
      !['close-requested', 'prepared', 'creating', 'held'].includes(attempt.status) ||
      closed?.launchId !== attempt.id || !isId(closed.writerId))
    refuse('Prior owner launch has no proved pre-pane closeout; inspect before retrying');
  if (grant.ownerToken !== state.ownerToken || grant.supervisorSession !== state.supervisorSession ||
      attempt.ownerToken !== state.ownerToken) {
    // The grant is written before the attempt. Its exact token lineage is the
    // durable receipt for every owner that previously rebound this B attempt.
    const lineage = grant.rebindTokens ?? [closed.ownerToken];
    if (!closed.ownerToken || !Array.isArray(lineage) || lineage[0] !== closed.ownerToken ||
        lineage.at(-1) !== grant.ownerToken || new Set(lineage).size !== lineage.length ||
        !lineage.every(isId) || !lineage.includes(attempt.ownerToken) ||
        !state.ownerToken || !state.supervisorSession ||
        (grant.ownerToken === state.ownerToken && grant.supervisorSession !== state.supervisorSession) ||
        (lineage.includes(state.ownerToken) && grant.ownerToken !== state.ownerToken))
      refuse('Prior supervisor ownership is unresolved');
    for (const token of lineage) {
      if (token !== state.ownerToken && await ownerAlive(root, token))
        refuse('Prior supervisor ownership is unresolved');
    }
    if (grant.ownerToken !== state.ownerToken) {
      grant.rebindTokens = [...lineage, state.ownerToken];
      grant.ownerToken = state.ownerToken;
      grant.supervisorSession = state.supervisorSession;
      await atomicJson(grantPath(root, grant.id), grant);
    }
    attempt.ownerToken = state.ownerToken;
    await atomicJson(spawnPath(root, attempt.id), attempt);
  }
  return { grant, attempt, closed };
}

function typedOwnerReport(current, binding, evidence) {
  return evidence?.workerId === binding.workerId && evidence.stop === current.commandReport?.stop &&
    evidence.version === current.version && current.hold && current.holdReason === 'typing' &&
    current.parkedReport?.stop === evidence.stop;
}

async function closeoutCandidate(root, checkout, grantId, state, live, readPane, readSnapshot, commandEvidence) {
  const grant = await readJson(grantPath(root, grantId));
  const claim = await readJson(writerClaimPath(root, checkout));
  const attempt = await readJson(spawnPath(root, claim.id));
  const owner = Object.values(state.workers).find(w => w.role === 'owner' && w.coordinatorId === grantId);
  const children = Object.values(state.workers).filter(w => w.recipient?.id === grantId);
  if (!grant.ownerLaunch || grant.revoked || grant.checkout !== checkout || claim.grantId !== grantId ||
      attempt.id !== claim.id || attempt.grantId !== grantId || attempt.role !== 'writer' ||
      attempt.status !== 'dispatched' || !owner || !children.some(w => w.delegationId === claim.id) ||
      state.ownerWaits[owner.workerId]) refuse('Prior assignment is not eligible for closeout');
  const key = digest(`${grantId}\nassignment-owner`);
  const ownerKey = await readJson(join(root, `spawn-key-${key}.json`));
  const ownerAttempt = await readJson(spawnPath(root, ownerKey.id));
  if (ownerAttempt.status !== 'dispatched' || ownerAttempt.workerId !== owner.workerId ||
      ownerAttempt.grantId !== grantId || state.routes[owner.route]?.paused ||
      !sameOccupant(live.agents.find(a => a.pane_id === owner.paneId), owner))
    refuse('Prior assignment owner or startup changed');
  for (const file of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const spawned = await readJson(join(root, file));
    if (spawned.grantId === grantId && spawned.status !== 'dispatched' &&
        !(file === `spawn-${spawned.id}.json` && await settledWriterPreflight(root, spawned, grant,
          { spawnId: ownerAttempt.id, workerId: owner.workerId }, owner)))
      refuse(`Unresolved assignment startup ${spawned.id}`);
  }
  for (const binding of [owner, ...children]) {
    const agent = live.agents.find(a => a.pane_id === binding.paneId);
    const current = await readObservation(root, binding.workerId);
    const typedOwner = binding === owner && typedOwnerReport(current, binding, commandEvidence);
    // Pi marks the exact command's owner working while it runs. The previous
    // settled report is usable only through its still-fenced typing witness.
    const settledLive = sameOccupant(agent, binding) && (['idle', 'done'].includes(agent.agent_status) ||
      (typedOwner && agent.agent_status === 'working'));
    let absentReviewer = false;
    if (!agent && binding.delegationId) {
      const reviewAttempt = await readJson(spawnPath(root, binding.delegationId));
      absentReviewer = reviewAttempt.role === 'read-only' && reviewAttempt.grantId === grantId &&
        reviewAttempt.status === 'dispatched' && reviewAttempt.workerId === binding.workerId &&
        await absentSession(binding, live, readPane, readSnapshot);
    }
    if ((!settledLive && !absentReviewer) || state.inflight[binding.workerId] ||
        state.ownerWaits[binding.workerId] || state.dispositions[binding.workerId]?.action === 'decision' ||
        Object.values(state.notices).some(n => (n.workerId === binding.workerId ||
          n.recipient?.id === grantId) && unresolvedNotice(n)))
      refuse(`Assignment worker ${binding.workerId} is active or has unresolved effects`);
    const observation = typedOwner ? current.commandReport : current;
    if (!sameSession(observation.session, binding) || observation.hold ||
        observation.bootstrapPending || observation.outcome !== 'completed')
      refuse(`Assignment worker ${binding.workerId} has no settled eligible report`);
  }
  return { grant, claim, bindings: [owner, ...children] };
}

async function isLegacyCheckoutRefusal(root, attempt, grant, file, state, treeFence, legacyFence) {
  // v0.4.5/v0.4.6 wrote `held` for these checkout refusals, both emitted
  // before pane.split. Missing pane fields alone are not proof of no effect.
  const knownRefusal = attempt.failure === 'Checkout already has a supervised worker; delegate read-only work or inspect writer ownership' ||
    /^Checkout already has a supervised worker [a-f0-9-]{36}: unverified observation, unresolved startup, or approval; inspect writer ownership$/.test(attempt.failure);
  if (!knownRefusal || attempt.status !== 'held' || !isId(attempt.id) || file !== `spawn-${attempt.id}.json` ||
      attempt.role !== 'owner' || attempt.key !== 'assignment-owner' || !grant.ownerLaunch ||
      attempt.grantId !== grant.id || attempt.ownerToken !== grant.ownerToken || attempt.task !== grant.scope ||
      !isDeepStrictEqual(attempt.parent, grant.parent) || !isDeepStrictEqual(attempt.authority, { grantId: grant.id }) ||
      grant.worktreeCreated || grant.closeAssignment ||
      ['paneRequested', 'paneId', 'terminalId', 'workspaceId', 'tabId', 'child', 'workerId',
        'closeRequested', 'abandonRequested'].some(key => Object.hasOwn(attempt, key)) ||
      [state.workers, state.retiredWorkers].some(workers => Object.values(workers).some(w => w.delegationId === attempt.id)))
    return false;
  for (const path of new Set([treeFence, legacyFence])) {
    try { if ((await readJson(path)).token === attempt.id) return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await access(join(root, `spawn-receipt-${attempt.id}.json`)); return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return true; }
}

// A historical assignment can be abandoned only as an exact set. Pending
// notices keep their unknown outcome. A legacy claim must resolve to this tree.
async function abandonmentCandidate(root, checkout, oldId, state, live, readPane, readSnapshot, launchId) {
  const grant = await readJson(grantPath(root, oldId));
  if (!grant.ownerLaunch || grant.revoked || await checkoutIdentity(grant.cwd, grant.checkout) !== grant.checkout ||
      await checkoutRoot(grant.cwd) !== checkout ||
      (grant.ownerToken !== state.ownerToken && await ownerAlive(root, grant.ownerToken)))
    refuse('Old assignment checkout or supervisor ownership changed');
  const claimPath = writerClaimPath(root, grant.checkout);
  const claim = await readJson(claimPath);
  const treePath = writerClaimPath(root, checkout);
  const legacyPath = writerClaimPath(root, await commonDirectory(grant.cwd));
  for (const otherPath of new Set([treePath, legacyPath])) {
    if (otherPath === claimPath) continue;
    try { await readJson(otherPath); refuse('Another writer claim may own this checkout'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const writer = await readJson(spawnPath(root, claim.id));
  if (claim.grantId !== oldId || writer.id !== claim.id || writer.grantId !== oldId ||
      writer.role !== 'writer' || writer.status !== 'dispatched')
    refuse('Old assignment writer claim is not attributable');
  const owner = Object.values(state.workers).find(w => w.role === 'owner' && w.coordinatorId === oldId);
  if (!owner || !Object.values(state.workers).some(w => w.delegationId === writer.id))
    refuse('Old assignment owner or writer is not retained');
  const ownerKey = await readJson(join(root, `spawn-key-${digest(`${oldId}\nassignment-owner`)}.json`));
  const ownerAttempt = await readJson(spawnPath(root, ownerKey.id));
  if (ownerAttempt.status !== 'dispatched' || ownerAttempt.workerId !== owner.workerId ||
      ownerAttempt.grantId !== oldId) refuse('Old owner startup is unresolved');

  const bindings = [];
  for (const binding of Object.values(state.workers)) {
    let tree;
    try { tree = await checkoutRoot(binding.cwd); }
    catch { refuse(`Worker ${binding.workerId} checkout cannot be verified`); }
    if (tree !== checkout) continue;
    if (!binding.paused || state.inflight[binding.workerId] || state.ownerWaits[binding.workerId])
      refuse(`Worker ${binding.workerId} has active authority or an unresolved effect`);
    if (binding.role === 'owner' && binding.coordinatorId !== oldId)
      refuse(`Worker ${binding.workerId} belongs to another owner grant`);
    let reviewer = false;
    if (binding.delegationId) {
      const child = await readJson(spawnPath(root, binding.delegationId));
      if (child.grantId !== oldId || child.workerId !== binding.workerId || child.status !== 'dispatched')
        refuse(`Worker ${binding.workerId} has independent or unfinished delegation authority`);
      reviewer = child.role === 'read-only' && binding.recipient?.id === oldId;
    }
    const saved = await readJson(join(root, `worker-${binding.workerId}.json`));
    const observed = await readObservation(root, binding.workerId);
    if (!registrationMatches(saved, binding) || await realpath(saved.checkpoint) !== binding.checkpoint ||
        !sameSession(observed.session, binding) || observed.bootstrapPending ||
        !await absentSession(binding, live, readPane, readSnapshot))
      refuse(`Worker ${binding.workerId} identity, startup or absence is unverified`);
    // Retiring an absent reviewer with a different settled stop does not answer
    // the previous decision. Keep the disposition and all delivery history.
    const disposition = state.dispositions[binding.workerId];
    if (disposition?.action === 'decision' && (!reviewer || observed.outcome !== 'completed' ||
        observed.hold || unresolvedDecisionAtStop(disposition, observed.stop)))
      refuse(`Worker ${binding.workerId} has active authority or an unresolved effect`);
    bindings.push(binding);
  }
  if (!bindings.some(w => w.workerId === owner.workerId) ||
      !bindings.some(w => w.delegationId === writer.id) || !await noRelatedStartup(root, bindings))
    refuse('Old assignment startup or checkout membership is unresolved');
  const treeFence = ownerLaunchPath(root, checkout);
  const legacyFence = ownerLaunchPath(root, await commonDirectory(grant.cwd));
  for (const file of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const started = await readJson(join(root, file));
    if (started.id === launchId || started.status === 'dispatched' ||
        (started.status === 'preflight-refused' && started.paneRequested !== true &&
          !started.paneId && !started.child)) continue;
    const scope = await readJson(grantPath(root, started.grantId));
    if (scope.checkout !== checkout && scope.checkout !== grant.checkout) continue;
    if (!await isLegacyCheckoutRefusal(root, started, scope, file, state, treeFence, legacyFence))
      throw Object.assign(new Error(`Unresolved checkout launch ${started.id}`), { code: 'UNRESOLVED_CHECKOUT_LAUNCH' });
  }
  const ids = new Set(bindings.map(w => w.workerId));
  for (const notice of Object.values(state.notices)) {
    if ((ids.has(notice.workerId) || notice.recipient?.id === oldId) && unresolvedNotice(notice)) {
      if (!ids.has(notice.workerId) || notice.status !== 'pending' ||
          (notice.recipient && notice.recipient.id !== oldId))
        refuse(`Notice ${notice.id} has an unresolved delivery effect`);
    }
  }
  return { grant, claim, claimPath, bindings };
}

async function requireNoWriterClaim(root, checkout, cwd) {
  const paths = [writerClaimPath(root, checkout)];
  const legacy = await commonDirectory(cwd);
  if (legacy !== checkout) paths.push(writerClaimPath(root, legacy));
  for (const path of paths) {
    let existing;
    try { existing = await readJson(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (path !== paths[0]) {
      // A legacy claim carries no working-tree ID. Its grant is the only
      // durable witness that it belongs to a different tree.
      let grant;
      try { grant = await readJson(grantPath(root, existing.grantId)); }
      catch { refuse('Legacy writer claim has unverified checkout; inspect ownership before launch'); }
      if (await checkoutRoot(grant.cwd) !== checkout) continue;
    }
    refuse(`Checkout retains a writer claim${isId(existing?.id) ? ` ${existing.id}` : ''}; inspect ownership before launch`);
  }
}

/** Owner queue only. No notice selection supplied by the caller; derive it from
 * the exact native checkout attempt and the current supervisor snapshot. */
export async function closeLaunchAssignment(root, request, state, readPane, readSnapshot, stillCurrent, commit) {
  const attempt = await readJson(spawnPath(root, request.id));
  const { grant } = await delegationAuthority(root, attempt.authority, attempt.parent, request.commandEvidence);
  if (attempt.id !== request.id || attempt.status !== 'close-requested' || attempt.role !== 'owner' ||
      attempt.grantId !== grant.id || attempt.ownerToken !== state.ownerToken || !grant.ownerLaunch ||
      grant.closeAssignment !== request.grantId || attempt.task !== grant.scope ||
      (await readJson(ownerLaunchPath(root, grant.checkout))).token !== attempt.id)
    refuse('No matching native close-and-start attempt');
  const previous = structuredClone(state);
  const live = await readSnapshot();
  requireDelegationParent(live, attempt.parent);
  const recorded = state.closedAssignments?.[request.grantId];
  if (recorded) {
    if (recorded.launchId !== attempt.id || !attempt.closeRequested || attempt.paneRequested !== false ||
        attempt.paneId || attempt.child ||
        !isId(recorded.writerId) || Object.values(state.workers).some(w =>
          w.coordinatorId === request.grantId || w.recipient?.id === request.grantId) ||
        !Object.values(state.retiredWorkers).some(w =>
          w.delegationId === recorded.writerId && w.retiredBy === attempt.id) || !stillCurrent())
      refuse('Recorded closeout identity or effect boundary changed');
    const old = await readJson(grantPath(root, request.grantId));
    if (old.id !== request.grantId || !old.ownerLaunch || old.checkout !== grant.checkout)
      refuse('Recorded closeout grant changed');
    const path = writerClaimPath(root, grant.checkout);
    let claim;
    try { claim = await readJson(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (claim && (claim.id !== recorded.writerId || claim.grantId !== request.grantId))
      refuse('Another assignment owns the writer claim');
    if (!old.revoked) await atomicJson(grantPath(root, old.id), { ...old, revoked: true });
    if (claim) await rm(path);
    return request.grantId;
  }
  const closing = await closeoutCandidate(root, grant.checkout, request.grantId, previous, live, readPane, readSnapshot, request.commandEvidence);
  if (!stillCurrent() || !isDeepStrictEqual(previous, state) ||
      (await readJson(ownerLaunchPath(root, grant.checkout))).token !== attempt.id ||
      !isDeepStrictEqual(attempt, await readJson(spawnPath(root, attempt.id))))
    refuse('Assignment closeout evidence changed');
  const final = await readSnapshot();
  requireDelegationParent(final, attempt.parent);
  await closeoutCandidate(root, grant.checkout, request.grantId, state, final, readPane, readSnapshot, request.commandEvidence);
  for (const binding of closing.bindings) {
    state.retiredWorkers[binding.workerId] = { ...binding, paused: true, retiredBy: attempt.id };
    delete state.workers[binding.workerId];
  }
  state.closedAssignments ??= {};
  state.closedAssignments[request.grantId] = { launchId: attempt.id, writerId: closing.claim.id,
    ownerToken: attempt.ownerToken, at: new Date().toISOString() };
  try { await commit(); }
  catch (error) { Object.assign(state, previous); throw error; }
  await atomicJson(grantPath(root, request.grantId), { ...closing.grant, revoked: true });
  const claim = await readJson(writerClaimPath(root, grant.checkout));
  if (!isDeepStrictEqual(claim, closing.claim)) refuse('Writer claim changed during closeout');
  await rm(writerClaimPath(root, grant.checkout));
  return request.grantId;
}

export async function assignmentRevision(cwd) {
  return (await exec('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'],
    { timeout: 2500, maxBuffer: 8192, windowsHide: true })).stdout.trim();
}

export async function recordAssignmentOutcome(root, state, request, live) {
  const owner = state.workers[request.workerId];
  const { revision, review, delivery } = request;
  if (owner?.role !== 'owner' || owner.coordinatorId !== request.grantId || owner.paused || owner.stopped ||
      owner.sessionId !== request.sessionId || owner.sessionFile !== request.sessionFile ||
      state.routes[owner.route]?.paused || state.ownerWaits[owner.workerId] ||
      !sameOccupant(live.agents.find(agent => agent.pane_id === owner.paneId), owner) ||
      typeof revision !== 'string' || !/^[a-f0-9]{40,64}$/.test(revision) ||
      [review, delivery].some(text => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1000))
    refuse('Delivery outcome requires the exact unheld owner and completed obligations');
  const grant = await readJson(grantPath(root, owner.coordinatorId));
  const attempt = await readJson(spawnPath(root, owner.delegationId));
  const observed = await readObservation(root, owner.workerId);
  if (!grant.ownerLaunch || grant.revoked || grant.id !== attempt.grantId || attempt.status !== 'dispatched' ||
      attempt.workerId !== owner.workerId || !sameSession(observed.session, owner) || observed.hold ||
      observed.outcome !== 'completed' || !isId(observed.stop) || observed.session.leaf !== request.leaf ||
      await assignmentRevision(grant.cwd) !== revision)
    refuse('Delivery outcome does not match the current assignment, settled reply and Git revision');
  state.assignmentOutcomes[grant.id] = { workerId: owner.workerId, stop: observed.stop, leaf: request.leaf,
    revision, review, delivery };
}

// The original claim remains in place until the supervisor commits the new
// assignment. The checkout fence remains held until both start receipts exist.
export async function startRetainedAssignment(root, request, state, readPane, readLive, stillCurrent, commit) {
  const old = await readJson(grantPath(root, request.grantId));
  const automatic = request.automatic === true;
  if (!automatic && !isDeepStrictEqual(old.parent, request.planner)) refuse('Retained launch belongs to another planning session');
  const existing = Object.values(state.retainedAssignments ?? {}).find(item => item.oldClaim.grantId === old.id);
  if (existing) {
    if (existing.grant.scope !== request.scope) refuse('Another retained assignment is already pending');
    return existing.grant.id;
  }
  const queue = state.assignmentQueues[old.id];
  const queued = queue?.[0];
  if (!queued || queued.scope !== request.scope)
    refuse('Retained launch requires the exact first queued assignment and its planning session');
  const live = await readLive();
  if (!automatic) requireDelegationParent(live, old.parent);
  const closing = await closeoutCandidate(root, old.checkout, old.id, state, live, readPane, readLive);
  const owner = closing.bindings.find(w => w.role === 'owner');
  const writer = closing.bindings.find(w => w.delegationId === closing.claim.id);
  const verifyOutcome = async () => {
    if (!automatic) return;
    const outcome = state.assignmentOutcomes[old.id];
    const observed = await readObservation(root, owner.workerId);
    if (!outcome || outcome.workerId !== owner.workerId || outcome.stop !== observed.stop ||
        outcome.leaf !== observed.session.leaf || outcome.revision !== await assignmentRevision(old.cwd))
      refuse('The owner delivery outcome is stale; record the completed obligations at the current revision');
  };
  await verifyOutcome();
  const boundary = binding => Object.fromEntries(['paneId', 'terminalId', 'workspaceId', 'tabId', 'cwd',
    'sessionId', 'sessionFile', 'sessionKind', 'sessionValue'].map(key => [key, binding[key]]));
  if (!owner || !writer || [owner, writer].some(w => w.paused || w.stopped || w.handoff || state.routes[w.route]?.paused))
    refuse('The original owner and writer must both be live, settled and unpaused');
  const grant = { ...old, id: queued.id, scope: queued.scope, ownerToken: state.ownerToken,
    supervisorSession: state.supervisorSession, closeAssignment: undefined, closeExplicit: undefined };
  delete grant.deliveryPreferences;
  grant.deliveryPreferences = await readDeliveryPreferences(root);
  const ticket = (oldBinding, role, parent, authority) => ({ id: randomUUID(), grantId: grant.id, role,
    workerId: randomUUID(), child: boundary(oldBinding), parent, authority, ownerToken: state.ownerToken,
    replacesWorker: oldBinding.workerId, replacesGrant: old.id, status: 'prepared', task: queued.scope,
    ...(automatic && { automatic }) });
  const ownerTicket = ticket(owner, 'owner', old.parent, { grantId: grant.id });
  const writerTicket = ticket(writer, 'writer', ownerTicket.child, { grantId: grant.id, spawnId: ownerTicket.id });
  writerTicket.parentWorkerId = ownerTicket.workerId;
  writerTicket.recipient = { id: grant.id };
  const ownerBinding = { ...ownerTicket.child, workerId: ownerTicket.workerId, delegationId: ownerTicket.id,
    checkpoint: managedCheckpointPath(root, ownerTicket.workerId), route: owner.route, paused: false,
    lastStartNonce: ownerTicket.id,
    role: 'owner', coordinatorId: grant.id };
  const writerBinding = { ...writerTicket.child, workerId: writerTicket.workerId, delegationId: writerTicket.id,
    checkpoint: managedCheckpointPath(root, writerTicket.workerId), route: writer.route, paused: false,
    lastStartNonce: writerTicket.id,
    recipient: { ...ownerTicket.child, id: grant.id, role: 'owner' } };
  const transition = { grant, ownerTicket, writerTicket, oldClaim: closing.claim, ...(automatic && { automatic }) };
  const fence = ownerLaunchPath(root, old.checkout);
  await claimOwnerLaunch(fence, grant.id, true);
  try {
    const latest = await readLive();
    if (!automatic) requireDelegationParent(latest, old.parent);
    await closeoutCandidate(root, old.checkout, old.id, state, latest, readPane, readLive);
    await verifyOutcome();
    if (!stillCurrent()) refuse('Retained closeout interrupted before commit');
  } catch (error) {
    await release(fence, grant.id);
    throw error;
  }
  for (const binding of closing.bindings) {
    state.retiredWorkers[binding.workerId] = { ...binding, paused: true, retiredBy: grant.id };
    delete state.workers[binding.workerId];
  }
  state.workers[ownerBinding.workerId] = ownerBinding;
  state.workers[writerBinding.workerId] = writerBinding;
  state.closedAssignments[old.id] = { launchId: grant.id, writerId: closing.claim.id,
    ownerToken: state.ownerToken, at: new Date().toISOString() };
  state.assignmentQueues[grant.id] = queue.slice(1);
  delete state.assignmentQueues[old.id];
  (state.retainedAssignments ??= {})[grant.id] = transition;
  await commit();
  return grant.id;
}

export async function finishRetainedAssignment(root, state, id, stillCurrent, commit, send = sendAction) {
  const transition = state.retainedAssignments?.[id];
  if (!transition || !stillCurrent()) return false;
  const { grant, ownerTicket, writerTicket, oldClaim } = transition;
  const old = await readJson(grantPath(root, oldClaim.grantId));
  const claimPath = writerClaimPath(root, grant.checkout);
  const fence = ownerLaunchPath(root, grant.checkout);
  const heldFence = await optionalRecord(fence);
  const finalize = async () => {
    if ((await optionalRecord(fence))?.token === grant.id) await release(fence, grant.id);
    delete state.retainedAssignments[id];
    const outcome = state.assignmentOutcomes?.[oldClaim.grantId];
    if (outcome) delete outcome.blocker;
    await commit();
    return true;
  };
  if (transition.completed) return finalize();
  if (heldFence?.token !== grant.id) refuse('Retained assignment checkout fence changed');
  const nextClaim = { id: writerTicket.id, grantId: grant.id };
  const currentClaim = await readJson(claimPath);
  if (!isDeepStrictEqual(currentClaim, oldClaim) && !isDeepStrictEqual(currentClaim, nextClaim))
    refuse('Retained assignment writer claim changed');
  const prepare = async (path, data) => {
    if (!await optionalRecord(path)) await claim(path, data);
  };
  if (grant.ownerToken !== state.ownerToken) {
    if (await ownerAlive(root, grant.ownerToken)) refuse('Retained assignment predecessor is still live');
    const previous = state.predecessorSupervisor;
    if (previous?.token !== grant.ownerToken || previous?.sessionId !== grant.supervisorSession)
      refuse('Retained assignment supervisor lineage changed');
    Object.assign(grant, { ownerToken: state.ownerToken, supervisorSession: state.supervisorSession });
    await commit();
  }
  await atomicJson(grantPath(root, grant.id), grant);
  await prepare(join(root, `spawn-key-${digest(`${grant.id}\nassignment-owner`)}.json`), { id: ownerTicket.id });
  if (!old.revoked) await atomicJson(grantPath(root, old.id), { ...old, revoked: true });
  if (isDeepStrictEqual(currentClaim, oldClaim)) await atomicJson(claimPath, nextClaim);
  for (const initial of [writerTicket, ownerTicket]) {
    const path = spawnPath(root, initial.id);
    const saved = await optionalRecord(path);
    const receiptPath = join(root, `spawn-receipt-${initial.id}.json`);
    const sent = receipt => receipt?.id === initial.id && receipt.status === 'sent';
    if (saved && !isDeepStrictEqual(saved, { ...initial, status: saved.status, ownerToken: saved.ownerToken }))
      refuse('Retained assignment ticket changed');
    if (sent(await optionalRecord(receiptPath))) {
      if (saved?.status === 'dispatching') await atomicJson(path, { ...saved, status: 'dispatched' });
      else if (saved?.status !== 'dispatched') refuse('Retained assignment receipt has no matching ticket');
      continue;
    }
    if (saved || await optionalRecord(receiptPath))
      refuse(`Retained ${initial.role} start is unconfirmed. Inspect its receipt; do not resend.`);
    if (!stillCurrent() || state.ownerToken !== grant.ownerToken || state.workers[initial.workerId]?.paused ||
        state.routes[state.workers[initial.workerId]?.route]?.paused) return false;
    const ticket = { ...initial, ownerToken: state.ownerToken, status: 'dispatching' };
    await claim(path, ticket);
    let reply;
    try {
      reply = await send(root, { type: 'retained-assignment', id: ticket.id,
        workerId: ticket.replacesWorker }, ticket.replacesWorker, { timeoutMs: 15000 });
    } catch {
      refuse(`Retained ${ticket.role} transport interrupted. Inspect its receipt before continuing; do not resend.`);
    }
    if (reply?.accepted && reply.id === ticket.id) {
      for (let i = 0; i < 100 && !sent(await optionalRecord(receiptPath)); i++) await delay(50);
    }
    if (!sent(await optionalRecord(receiptPath))) refuse(`Retained ${ticket.role} run was not observed. Inspect its receipt; do not resend.`);
    await atomicJson(path, { ...ticket, status: 'dispatched' });
  }
  // Keep the completed record until fence release is durable. A restart in
  // either direction of this boundary cannot repeat an observed task.
  transition.completed = true;
  await commit();
  return finalize();
}

export async function abandonLaunchAssignment(root, request, state, readPane, readSnapshot, stillCurrent, commit) {
  const attempt = await readJson(spawnPath(root, request.id));
  const { grant } = await delegationAuthority(root, attempt.authority, attempt.parent);
  if (attempt.id !== request.id || attempt.status !== 'close-requested' || attempt.role !== 'owner' ||
      attempt.grantId !== grant.id || attempt.ownerToken !== state.ownerToken || !grant.ownerLaunch ||
      !grant.abandonAssignment || grant.closeAssignment !== request.grantId ||
      attempt.task !== grant.scope || !attempt.closeRequested || attempt.paneRequested !== false ||
      attempt.paneId || attempt.child ||
      (await readJson(ownerLaunchPath(root, grant.checkout))).token !== attempt.id)
    refuse('No matching native abandonment attempt');
  const oldPath = grantPath(root, request.grantId);
  const oldGrant = await readJson(oldPath);
  const claimPath = writerClaimPath(root, oldGrant.checkout);
  const recorded = state.closedAssignments?.[request.grantId];
  if (recorded) {
    if (!recorded.abandoned || recorded.launchId !== attempt.id ||
        !Array.isArray(recorded.workerIds) || !recorded.workerIds.length ||
        recorded.workerIds.some(id => !state.retiredWorkers[id] || state.retiredWorkers[id].retiredBy !== attempt.id) ||
        Object.values(state.workers).some(w => recorded.workerIds.includes(w.workerId)) ||
        !stillCurrent()) refuse('Recorded abandonment identity or effect boundary changed');
    let claim;
    try { claim = await readJson(claimPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (claim && (claim.id !== recorded.writerId || claim.grantId !== request.grantId))
      refuse('Another assignment owns the writer claim');
    for (const otherPath of new Set([writerClaimPath(root, grant.checkout),
      writerClaimPath(root, await commonDirectory(oldGrant.cwd))])) {
      if (otherPath === claimPath) continue;
      try { await readJson(otherPath); refuse('Another writer claim appeared during abandonment'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!oldGrant.revoked) await atomicJson(oldPath, { ...oldGrant, revoked: true });
    if (claim) await rm(claimPath);
    return request.grantId;
  }
  const previous = structuredClone(state);
  const live = await readSnapshot();
  requireDelegationParent(live, attempt.parent);
  const selected = await abandonmentCandidate(root, grant.checkout, request.grantId, previous,
    live, readPane, readSnapshot, attempt.id);
  if (grant.confirmedRetryAbandonment && !matchesAbandonmentSelection(grant.confirmedRetryAbandonment, selected))
    refuse('Confirmed abandonment set or writer claim changed');
  if (!stillCurrent() || !isDeepStrictEqual(previous, state) ||
      !isDeepStrictEqual(attempt, await readJson(spawnPath(root, attempt.id))) ||
      (await readJson(ownerLaunchPath(root, grant.checkout))).token !== attempt.id ||
      !isDeepStrictEqual(selected.claim, await readJson(selected.claimPath)))
    refuse('Assignment abandonment evidence changed');
  const final = await readSnapshot();
  requireDelegationParent(final, attempt.parent);
  const checked = await abandonmentCandidate(root, grant.checkout, request.grantId, state,
    final, readPane, readSnapshot, attempt.id);
  if (!isDeepStrictEqual(checked.bindings, selected.bindings) ||
      !isDeepStrictEqual(checked.claim, selected.claim) || !stillCurrent())
    refuse('Assignment abandonment set or claim changed');
  const at = new Date().toISOString();
  for (const binding of selected.bindings) {
    state.retiredWorkers[binding.workerId] = { ...binding, paused: true, retiredBy: attempt.id,
      abandonedAssignment: { at, launchId: attempt.id } };
    delete state.workers[binding.workerId];
  }
  state.closedAssignments ??= {};
  state.closedAssignments[request.grantId] = { launchId: attempt.id, writerId: selected.claim.id,
    ownerToken: attempt.ownerToken, workerIds: selected.bindings.map(w => w.workerId), abandoned: true, at };
  try { await commit(); }
  catch (error) { Object.assign(state, previous); throw error; }
  await atomicJson(oldPath, { ...selected.grant, revoked: true });
  if (!isDeepStrictEqual(selected.claim, await readJson(selected.claimPath)))
    refuse('Writer claim changed during abandonment');
  await rm(selected.claimPath);
  return request.grantId;
}

export async function abandonLaunchApproval(root, request, state, readPane, readSnapshot, stillCurrent, commit) {
  const attempt = await readJson(spawnPath(root, request.id));
  const { grant } = await delegationAuthority(root, attempt.authority, attempt.parent);
  if (attempt.id !== request.id || attempt.status !== 'abandon-requested' || attempt.role !== 'owner' ||
      attempt.ownerToken !== state.ownerToken || attempt.grantId !== grant.id || !grant.ownerLaunch ||
      attempt.authority.spawnId || attempt.task !== grant.scope || !isId(request.workerId))
    refuse('No matching native start attempt');
  const fence = await readJson(ownerLaunchPath(root, grant.checkout));
  if (fence.token !== attempt.id) refuse('Native start fence changed');
  await requireNoWriterClaim(root, grant.checkout, grant.cwd);
  const previous = structuredClone(state);
  const live = await readSnapshot();
  requireDelegationParent(live, attempt.parent);
  const approvals = [];
  await inspectCheckout(root, grant, attempt.parent, undefined, previous, live, readPane, readSnapshot, true, approvals);
  if (approvals.length !== 1 || approvals[0] !== request.workerId)
    refuse('Historical approval is no longer the sole eligible abandonment');
  const worker = previous.workers[request.workerId];
  if (!worker || !await absentSession(worker, live, readPane, readSnapshot) ||
      !await noRelatedStartup(root, [worker]) || !stillCurrent() ||
      !isDeepStrictEqual(previous, state) ||
      (await readJson(ownerLaunchPath(root, grant.checkout))).token !== attempt.id ||
      !isDeepStrictEqual(attempt, await readJson(spawnPath(root, attempt.id))))
    refuse('Historical approval or launch evidence changed');
  await requireNoWriterClaim(root, grant.checkout, grant.cwd);
  state.retiredWorkers[request.workerId] = { ...worker, paused: true, retiredBy: attempt.id,
    abandonedApproval: { at: new Date().toISOString(), launchId: attempt.id } };
  delete state.workers[request.workerId];
  try { await commit(); }
  catch (error) { Object.assign(state, previous); throw error; }
  return request.workerId;
}

export async function archiveLaunchNotices(root, request, state, readPane, readSnapshot, stillCurrent, commit) {
  const id = request.id;
  const attempt = await readJson(spawnPath(root, id));
  const { grant } = await delegationAuthority(root, attempt.authority, attempt.parent);
  const fence = ownerLaunchPath(root, grant.checkout);
  const verifyAttempt = async () => {
    const launch = await readJson(fence);
    if (launch.token !== id || !isDeepStrictEqual(attempt, await readJson(spawnPath(root, id))))
      refuse('Native start attempt changed');
    await requireNoWriterClaim(root, grant.checkout, grant.cwd);
  };
  if (attempt.id !== id || attempt.status !== 'prepared' || attempt.role !== 'owner' ||
      attempt.ownerToken !== state.ownerToken || attempt.grantId !== grant.id || !grant.ownerLaunch ||
      attempt.authority.spawnId || attempt.task !== grant.scope) refuse('No matching native start attempt');
  await verifyAttempt();
  const previous = structuredClone(state);
  const live = await readSnapshot();
  requireDelegationParent(live, attempt.parent);
  const pending = await inspectCheckout(root, grant, attempt.parent, undefined, previous, live, readPane, readSnapshot, true);
  for (const notice of pending.values()) {
    if (!await canArchiveNotice(root, notice, previous, readPane, readSnapshot))
      refuse(`Pending blocker notice ${notice.id} for worker ${notice.workerId} has unverified history; inspect delivery`);
  }
  await verifyAttempt();
  const beforeArchive = await readSnapshot();
  const endpoints = new Map();
  for (const notice of pending.values()) {
    for (const binding of [previous.workers[notice.workerId], notice.unsentRecipient]) {
      if (endpoints.has(binding)) continue;
      const occupant = historicalPane(binding, beforeArchive);
      if (occupant === undefined || !await absentSession(binding, beforeArchive, readPane, readSnapshot))
        refuse(`Blocker notice ${notice.id} endpoint changed or is unverified; inspect delivery`);
      endpoints.set(binding, { occupant, noticeId: notice.id });
    }
  }
  // Use one final view for every endpoint so later pane checks do not
  // hide a relocation that happened while checking another notice.
  const final = await readSnapshot();
  requireDelegationParent(final, attempt.parent);
  for (const [binding, { occupant, noticeId }] of endpoints) {
    if (!isDeepStrictEqual(occupant, historicalPane(binding, final)))
      refuse(`Blocker notice ${noticeId} endpoint changed or is unverified; inspect delivery`);
  }
  if (!stillCurrent() || !isDeepStrictEqual(previous, state)) refuse('Supervisor or checkout state changed before archival');
  const at = new Date().toISOString();
  for (const id of pending.keys()) {
    const notice = state.notices[id];
    const { sessionId, sessionFile, paneId } = state.workers[notice.workerId];
    notice.archive = { at, reason: 'orphaned-before-send', sender: { sessionId, sessionFile, paneId },
      recipient: notice.unsentRecipient, launchId: attempt.id };
    delete notice.unsentRecipient;
    notice.status = 'archived';
  }
  if (pending.size) await commit();
  return [...pending.keys()];
}

const registrationMatches = (saved, binding) => sameSession({ id: saved.sessionId, file: saved.sessionFile }, binding) &&
  saved.cwd === binding.cwd && saved.paneId === binding.paneId;

// Launch protocol owns phase interpretation. Unknown or malformed history cannot
// establish independence; a related non-dispatched attempt remains unresolved.
export async function unresolvedStartupForWorker(root, binding) {
  const phases = new Set(['prepared', 'creating', 'split-requested', 'workspace-requested',
    'starting', 'enrolling', 'dispatching', 'dispatched', 'held', 'preflight-refused',
    'close-requested', 'abandon-requested']);
  for (const file of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const attempt = await readJson(join(root, file));
    if (file !== `spawn-${attempt?.id}.json` || !phases.has(attempt.status) ||
        typeof attempt.parent?.sessionId !== 'string' || typeof attempt.parent?.sessionFile !== 'string' ||
        (attempt.child !== undefined && (typeof attempt.child?.sessionId !== 'string' ||
          typeof attempt.child?.sessionFile !== 'string')) ||
        (attempt.status === 'preflight-refused' &&
          (attempt.paneRequested === true || attempt.paneId || attempt.child || attempt.closeRequested || attempt.abandonRequested)))
      return { unverified: true };
    if (attempt.status !== 'dispatched' && [attempt.parent, attempt.child].some(ref => ref &&
      (ref.sessionId === binding.sessionId || ref.sessionFile === binding.sessionFile)))
      return { related: attempt.id };
  }
  return null;
}

async function noRelatedStartup(root, bindings) {
  for (const file of await readdir(root)) {
    if (!/^spawn-[a-f0-9-]{36}\.json$/.test(file)) continue;
    const attempt = await readJson(join(root, file));
    if (file !== `spawn-${attempt.id}.json` || !exactSessionReference(attempt.parent ?? {})) return false;
    if (attempt.status === 'dispatched') continue;
    if ([attempt.parent, attempt.child].some(ref => ref && bindings.some(binding =>
      ref.sessionId === binding.sessionId || ref.sessionFile === binding.sessionFile))) return false;
  }
  return true;
}

async function canArchiveNotice(root, notice, state, readPane, readSnapshot) {
  if (!isId(notice.id) || !isId(notice.workerId)) return false;
  const sender = state.workers[notice.workerId];
  const recipient = notice.unsentRecipient;
  const addressed = notice.recipient ?? state.routes[notice.route]?.coordinator;
  if (!sender || sender.route !== notice.route || !isDeepStrictEqual(addressed, recipient) ||
      (notice.recipient && !isDeepStrictEqual(sender.recipient, recipient)) || !isId(recipient.id)) return false;
  const owner = Object.values(state.workers).find(worker => worker.sessionId === recipient.sessionId ||
    worker.sessionFile === recipient.sessionFile || worker.coordinatorId === recipient.id);
  if (owner && (!owner.paused || owner.coordinatorId !== recipient.id || !sameSession({ id: recipient.sessionId,
    file: recipient.sessionFile }, owner) || state.ownerWaits[owner.workerId] || state.inflight[owner.workerId] ||
    state.dispositions[owner.workerId]?.action === 'decision')) return false;
  try {
    const observed = await readObservation(root, sender.workerId);
    if (!sameSession(observed.session, sender) || observed.bootstrapPending || observed.hold ||
        observed.outcome === 'approval') return false;
    const registeredRecipient = await readJson(join(root, `coordinator-${recipient.id}.json`));
    if (registeredRecipient.id !== recipient.id || !registrationMatches(registeredRecipient, recipient) ||
        !await noRelatedStartup(root, [sender, recipient])) return false;
    await readJson(join(root, `receipt-${notice.id}.json`)).then(() => { refuse('Notice receipt exists'); }, error => {
      if (error.code !== 'ENOENT') throw error;
    });
    return await absentSession(recipient, await readSnapshot(), readPane, readSnapshot) &&
      await absentSession(sender, await readSnapshot(), readPane, readSnapshot);
  } catch { return false; }
}

export const delegationInstructions = 'Stay within the approved delegation scope. Delegation grants no secrets, deployment, publication or expanded task authority. ' +
  'Keep one implementation writer per checkout; read-only delegates must not edit source or delegate writers. ' +
  'Independent review is not acceptance. Awaiting user finding selection is a genuine decision pause: do not apply review findings or resume through that gate until the user selects them.';

/** One durable attempt, never resumed after a crash or a lost response. Read-only
 * readiness checks may repeat; pane creation, agent start, enrollment and task send may not. */
export async function spawnDelegated({ root, socketPath, paneId, ctx, reference, task, role, key,
  signal, ownerLaunch = false, retryAbandonAssignment, commandEvidence, allowed = () => true,
  selectApproval = (title, choices) => ctx.ui.select(title, choices),
  transport = request, readSnapshot = snapshot, send = sendAction }) {
  if (!(ownerLaunch ? role === 'owner' : ['writer', 'read-only'].includes(role)) || !task?.trim() || Buffer.byteLength(task) > 16000 ||
      !key?.trim() || key.length > 120) refuse('A stable assignment key, bounded task and writer/read-only role are required');
  const session = currentSession(ctx);
  const live = await readSnapshot(socketPath);
  const parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), session, ctx.cwd);
  const authority = await delegationAuthority(root, reference, parent, commandEvidence);
  if (role === 'writer' && authority.role === 'read-only') refuse('Read-only delegates cannot create writers');
  if (authority.recovery) await requireSettledRecoveryEffects(root, authority);
  if (ownerLaunch ? !authority.grant.ownerLaunch || reference.spawnId || task !== authority.grant.scope :
    authority.grant.ownerLaunch && !reference.spawnId) refuse('Owner launch requires the native start command');
  const checkLocal = () => {
    signal?.throwIfAborted();
    if (!allowed() || !sameSession(currentSession(ctx), parent)) refuse('Parent interaction/identity changed; inspect delegation');
  };
  const check = async () => {
    checkLocal();
    const current = await delegationAuthority(root, reference, parent, commandEvidence);
    if (current.ownerToken !== authority.ownerToken) refuse('Supervisor changed during delegation');
    const state = current.state;
    const fresh = await readSnapshot(socketPath);
    requireDelegationParent(fresh, parent, !!current.recovery);
    return { state, fresh, current };
  };
  await check();
  const attemptKey = digest(`${authority.grant.id}\n${key}`);
  const assignmentKey = digest(`${authority.grant.id}\n${task}`);
  const keyPath = join(root, `spawn-key-${attemptKey}.json`);
  const assignmentPath = join(root, `spawn-assignment-${assignmentKey}.json`);
  let id = randomUUID();
  let retry;
  if (ownerLaunch || role === 'writer') {
    try {
      const keyed = await readJson(keyPath);
      const assigned = await readJson(assignmentPath);
      const previous = await readJson(spawnPath(root, keyed.id));
      const recoveringClose = ownerLaunch && authority.grant.closeAssignment &&
        (await recordedCloseout(root, authority.grant.checkout, task, parent,
          (await delegationAuthority(root, reference, parent, commandEvidence)).state))?.attempt.id === previous.id;
      const eligible = assigned.id === keyed.id && previous.id === keyed.id &&
        (previous.status === 'preflight-refused' || recoveringClose) &&
        previous.grantId === authority.grant.id && previous.key === key && previous.task === task &&
        previous.role === role && previous.paneRequested !== true && !previous.paneId && !previous.child &&
        previous.ownerToken === authority.grant.ownerToken &&
        isDeepStrictEqual(previous.parent, parent) && !authority.grant.worktreeCreated;
      if (!eligible && ownerLaunch)
        refuse('Prior owner launch has no proved pre-effect refusal; inspect before retrying');
      if (eligible) {
        id = keyed.id;
        retry = previous;
        if (recoveringClose) retry.recoveringClose = true;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Claims survive all uncertain effects. Only this exact durable preflight
  // refusal can reuse them, never an attempted pane split or another key.
  if (!retry) {
    await claim(keyPath, { id });
    await claim(assignmentPath, { id });
  }
  const parentWorker = Object.values(authority.state.workers).find(w => w.sessionId === parent.sessionId &&
    w.paneId === parent.paneId);
  const recipient = ownerLaunch ? undefined : parentWorker?.recipient ?? (parentWorker?.role === 'owner' ?
    { id: parentWorker.coordinatorId } : undefined);
  const resumingClose = !!retry?.recoveringClose;
  const confirmedRetry = !!retry && confirmedRetryAbandonment(authority.grant, retry);
  if (retryAbandonAssignment && (!ownerLaunch || !retry || resumingClose || authority.grant.closeAssignment ||
      retry.closeRequested || retry.abandonRequested)) refuse('Prior launch cannot adopt the abandonment choice');
  const spawn = retry ?? { id, grantId: authority.grant.id, authority: reference, ownerToken: authority.ownerToken,
    parent, role, key, task, status: 'prepared', at: new Date().toISOString(),
    ...(recipient ? { recipient, parentWorkerId: parentWorker.workerId } : {}) };
  if (!retry) await claim(spawnPath(root, id), spawn);
  const save = async status => { spawn.status = status; await atomicJson(spawnPath(root, id), spawn); };
  const launchFence = ownerLaunch || role === 'writer' ? ownerLaunchPath(root, authority.grant.checkout) : undefined;
  const readPane = id => transport(socketPath, 'pane.get', { pane_id: id });
  const readLive = () => readSnapshot(socketPath);
  let fenceClaimed = false;
  let writerClaimed = false;
  let splitRequested = false;
  let abandonRequested = false;
  let closeRequested = false;
  let dispatched = false;
  try {
    if (launchFence) {
      await claimOwnerLaunch(launchFence, id, resumingClose || confirmedRetry);
      fenceClaimed = true;
    }
    if (resumingClose) {
      if (spawn.failure) {
        spawn.closeFailures = [...(spawn.closeFailures ?? []), { at: new Date().toISOString(), reason: spawn.failure }];
        delete spawn.failure;
      }
      delete spawn.recoveringClose;
    } else if (retry && !retryAbandonAssignment && !confirmedRetry) await save('prepared');
    const oldId = retryAbandonAssignment ?? authority.grant.closeAssignment;
    if (ownerLaunch && oldId) {
      let candidate;
      if (retryAbandonAssignment || authority.grant.abandonAssignment) {
        let historicalReviewerDecision = false;
        if (!resumingClose) {
          const old = (await delegationAuthority(root, reference, parent, commandEvidence)).state;
          candidate = await abandonmentCandidate(root, authority.grant.checkout, oldId, old,
            await readLive(), readPane, readLive, id);
          historicalReviewerDecision = candidate.bindings.some(w => old.dispositions[w.workerId]?.action === 'decision');
        }
        let supported = false;
        try { supported = await supportsAssignmentAbandonment(root, authority.grant.ownerToken, historicalReviewerDecision); }
        catch { /* An unknown endpoint is not evidence of support. */ }
        if (!supported) refuse('Running supervisor does not support assignment abandonment for this set; reload or restart the supervisor session before confirming. Reload this planning session if it still uses older code.');
      }
      let confirmedSelection;
      if (candidate) {
        confirmedSelection = abandonmentSelection(candidate);
        if (confirmedRetry) {
          if (!matchesAbandonmentSelection(authority.grant.confirmedRetryAbandonment, candidate))
            refuse('Confirmed abandonment set or writer claim changed');
        } else {
          const named = confirmedSelection.workerIds.join(', ');
          const choice = await selectApproval(`Abandon inactive assignment ${oldId} and its historical workers ${named}, preserving unanswered holds and unknown notice deliveries?`,
            ['Abandon exact set and start new assignment', 'Cancel']);
          if (choice !== 'Abandon exact set and start new assignment') refuse('Assignment abandonment cancelled');
        }
      } else if (!authority.grant.abandonAssignment && !authority.grant.closeExplicit && !resumingClose) {
        const choice = await selectApproval(`Close assignment ${oldId} and start this new assignment?`,
          ['Close old assignment and start new one', 'Cancel']);
        if (choice !== 'Close old assignment and start new one') refuse('Assignment closeout cancelled');
      }
      checkLocal();
      if (retryAbandonAssignment) {
        // Keep preflight-refused until the effect request is recorded. If Pi
        // exits after this grant write, the same pre-effect attempt can resume
        // using only this confirmed set and the matching checkout fence.
        authority.grant.closeAssignment = oldId;
        authority.grant.abandonAssignment = true;
        authority.grant.confirmedRetryAbandonment = { launchId: id, ...confirmedSelection };
        await atomicJson(grantPath(root, authority.grant.id), authority.grant);
      }
      closeRequested = true;
      spawn.closeRequested = true;
      spawn.paneRequested = false;
      await save('close-requested');
      const result = await send(root, { type: authority.grant.abandonAssignment ? 'launch-abandon-assignment' : 'launch-close',
        id, grantId: oldId, ownerToken: authority.grant.ownerToken, commandEvidence },  'supervisor', { timeoutMs: 15000 });
      if (!result.accepted || result.id !== id || result.grantId !== oldId)
        refuse(result.message ?? 'Assignment retirement unverified');
      await save('prepared');
    }
    if (role === 'writer' || ownerLaunch) {
      const { state: current, fresh } = await check();
      const approvals = ownerLaunch ? [] : undefined;
      const pending = await inspectCheckout(root, authority.grant, parent, recipient, current, fresh, readPane, readLive, ownerLaunch, approvals);
      if (ownerLaunch) {
        await requireNoWriterClaim(root, authority.grant.checkout, authority.grant.cwd);
        if (approvals.length) {
          if (approvals.length !== 1) refuse('Multiple historical approvals need separate inspection');
          const choice = await selectApproval(`Abandon inactive assignment ${approvals[0]} with its approval unanswered?`,
            ['Abandon old assignment and start new one', 'Cancel']);
          if (choice !== 'Abandon old assignment and start new one') refuse('Historical assignment abandonment cancelled');
          checkLocal();
          abandonRequested = true;
          await save('abandon-requested');
          const result = await send(root, { type: 'launch-abandon', id, workerId: approvals[0],
            ownerToken: authority.grant.ownerToken }, 'supervisor', { timeoutMs: 15000 });
          if (!result.accepted || result.id !== id || result.workerId !== approvals[0])
            refuse(result.message ?? 'Historical approval abandonment unverified');
          await save('prepared');
        }
        if (pending.size) {
          checkLocal();
          const result = await send(root, { type: 'launch-archive', id, ownerToken: authority.grant.ownerToken },
            'supervisor', { timeoutMs: 15000 });
          if (!result.accepted || result.id !== id) refuse(result.message ?? 'Historical notice disposition unverified');
          if (result.archived.length) ctx.ui.notify(`Archived ${result.archived.length} undelivered blocker notice(s); see supervisor status.`, 'info');
        }
      } else {
        // Serialize acquisitions against owner starts, then keep the existing
        // durable writer claim regardless of later dispatch or failures.
        await requireNoWriterClaim(root, authority.grant.checkout, authority.grant.cwd);
        await claim(writerClaimPath(root, authority.grant.checkout), { id, grantId: spawn.grantId });
        writerClaimed = true;
        await release(launchFence, id);
        fenceClaimed = false;
      }
    }
    await save('creating');
    const beforeSplit = await check();
    if (ownerLaunch || role === 'writer') {
      await inspectCheckout(root, authority.grant, parent, recipient, beforeSplit.state, beforeSplit.fresh, readPane, readLive, false);
      if (ownerLaunch) await requireNoWriterClaim(root, authority.grant.checkout, authority.grant.cwd);
      const latest = await check();
      const eligibilityState = ({ workers, notices, inflight, dispositions, ownerWaits, routes }) =>
        ({ workers, notices, inflight, dispositions, ownerWaits, routes });
      if (!isDeepStrictEqual(eligibilityState(beforeSplit.state), eligibilityState(latest.state)))
        refuse('Checkout eligibility changed before creation; inspect ownership');
    }
    if (authority.recovery) await requireSettledRecoveryEffects(root, (await check()).current, id);
    checkLocal();
    // From the first possible native effect until observed dispatch, retain the
    // checkout fence even if the response is lost or this process exits.
    spawn.paneRequested = true;
    await save(ownerLaunch && authority.grant.space === 'new' ? 'workspace-requested' : 'split-requested');
    splitRequested = true;
    const environment = { PI_CONTINUATION_SPAWN: id, PI_CONTINUATION_ROOT: root };
    const created = ownerLaunch && authority.grant.space === 'new' ?
      await transport(socketPath, 'workspace.create', {
        cwd: authority.grant.cwd, label: delegatedDisplayLabel('owner', authority.grant),
        focus: false, env: environment }) :
      await transport(socketPath, 'pane.split', { target_pane_id: paneId, direction: 'right',
        cwd: authority.grant.cwd, focus: false, env: environment });
    const split = created.type === 'workspace_created' ? { type: 'pane_info', pane: created.root_pane } : created;
    if (split.type !== 'pane_info' || !split.pane?.pane_id || split.pane.pane_id === paneId ||
        !split.pane.terminal_id || !split.pane.tab_id ||
        live.agents.some(a => a.pane_id === split.pane.pane_id) ||
        (ownerLaunch && authority.grant.space === 'new' ? created.type !== 'workspace_created' ||
          created.workspace?.workspace_id !== split.pane.workspace_id ||
          split.pane.workspace_id === parent.workspaceId : split.pane.workspace_id !== parent.workspaceId))
      refuse('Pane creation identity uncertain');
    spawn.paneId = split.pane.pane_id;
    spawn.terminalId = split.pane.terminal_id;
    spawn.workspaceId = split.pane.workspace_id;
    spawn.tabId = split.pane.tab_id;
    await check();
    await save('starting');
    // Unix Herdr rejects a shell with a foreground startup job. Wait for the
    // foreground shell to be alone, without submitting or retrying agent.start.
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const shellDeadline = performance.now() + 10000;
      while (true) {
        checkLocal();
        const status = await transport(socketPath, 'pane.process_info', { pane_id: spawn.paneId });
        const info = status.process_info;
        if (status.type !== 'pane_process_info' || info?.pane_id !== spawn.paneId)
          refuse('New pane shell readiness unavailable');
        if (info.shell_pid > 0 && info.foreground_process_group_id === info.shell_pid &&
            info.foreground_processes?.length === 1 && info.foreground_processes[0].pid === info.shell_pid) break;
        if (performance.now() >= shellDeadline) refuse('New pane shell did not become ready');
        await delay(150, undefined, { signal });
      }
    }
    await check();
    const target = await transport(socketPath, 'pane.get', { pane_id: spawn.paneId });
    if (target.type !== 'pane_info' || target.pane?.pane_id !== spawn.paneId || !spawn.terminalId ||
        target.pane.terminal_id !== spawn.terminalId || target.pane.workspace_id !== spawn.workspaceId ||
        target.pane.tab_id !== spawn.tabId || target.pane.agent || target.pane.agent_session)
      refuse('New pane changed before Pi startup');
    checkLocal();
    // Herdr names are at most 32 characters; keep the full UUID in base 36.
    const name = `pc-${BigInt(`0x${id.replaceAll('-', '')}`).toString(36)}`;
    const started = await transport(socketPath, 'agent.start', { name, kind: 'pi',
      pane_id: spawn.paneId, args: [], timeout_ms: 30000 }, { timeoutMs: 35000 });
    if (started.type !== 'agent_started') refuse('New Pi start was not acknowledged');
    let agent = started.agent;
    const deadline = performance.now() + 30000;
    // Raw agent.start acknowledges submission. Only read-only agent.get may
    // repeat while Herdr is still detecting this exact launched terminal.
    while (true) {
      if (!spawn.terminalId || agent?.terminal_id !== spawn.terminalId || agent.pane_id !== spawn.paneId ||
          agent.name !== name || (agent.agent && agent.agent !== 'pi'))
        refuse('New Pi startup identity changed');
      if (isSettled(agent) && agent.interactive_ready === true) break;
      if (agent.agent_status === 'blocked' || agent.launch_pending !== true)
        refuse('New Pi did not become interactive');
      if (performance.now() >= deadline) refuse('New Pi readiness timed out');
      await check();
      const status = await transport(socketPath, 'agent.get', { target: spawn.paneId });
      if (status.type !== 'agent_info') refuse('New Pi readiness unavailable');
      agent = status.agent;
      if (!(isSettled(agent) && agent.interactive_ready === true)) await delay(150, undefined, { signal });
    }
    await check();
    const hello = await send(root, { type: 'hello', id }, id);
    spawn.child = nativeBinding(agent, hello.session ?? {}, authority.grant.cwd);
    if (!hello.accepted || hello.id !== id) refuse('Ordinary continuation extension did not bind in the new Pi session');
    const { fresh } = await check();
    if (!sameOccupant(fresh.agents.find(a => a.pane_id === spawn.paneId), spawn.child)) refuse('New worker identity changed');
    await save('enrolling');
    checkLocal();
    const joined = await send(root, { type: 'enroll', id }, id, { timeoutMs: 15000 });
    if (!joined.accepted || joined.id !== id || !isId(joined.workerId)) refuse('New worker enrollment rejected or uncertain');
    spawn.workerId = joined.workerId;
    const { state } = await check();
    const binding = state.workers[spawn.workerId];
    if (!binding || binding.paused || !sameOccupant(agent, binding) ||
        binding.sessionId !== spawn.child.sessionId || state.routes[binding.route]?.paused)
      refuse('Exact owner enrollment is not active; assignment withheld');
    await save('dispatching');
    checkLocal();
    const result = await send(root, { type: 'assignment', id }, id);
    if (!result.accepted || result.id !== id) refuse('Assignment acceptance rejected or uncertain');
    // A void sendUserMessage is not observed delivery. Only the exact matching
    // native before_agent_start + agent_start pair makes this receipt sent.
    let receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await readJson(join(root, `spawn-receipt-${id}.json`));
      if (receipt.status === 'sent') break;
      signal?.throwIfAborted();
      await delay(50);
    }
    if (receipt.status !== 'sent') refuse('Assignment run was not observed; inspect, never resend');
    await save('dispatched');
    dispatched = true;
  } catch (error) {
    spawn.failure = error.message;
    if ((ownerLaunch && !splitRequested && !abandonRequested && !closeRequested && !authority.grant.worktreeCreated) ||
        (role === 'writer' && !writerClaimed && !splitRequested)) {
      spawn.preflightFailures = [...(spawn.preflightFailures ?? []),
        { at: new Date().toISOString(), reason: error.message }];
      await save('preflight-refused');
    } else await save('held');
    if (ownerLaunch && !splitRequested && !abandonRequested && !closeRequested)
      throw new Error(`Implementation start ${id} refused before pane creation; no agent started (${error.message}).`);
    throw new Error(`Delegation ${id} held for inspection (${error.message}). Do not retry under another key.`);
  } finally {
    if (fenceClaimed && (!splitRequested || dispatched)) {
      try { await release(launchFence, id); }
      catch { ctx.ui.notify(`Could not release owner launch fence ${id}; inspect before starting another`, 'warning'); }
    }
  }
  await labelNewPane(transport, socketPath, spawn.child, delegatedDisplayLabel(role, authority.grant));
  return { id, workerId: spawn.workerId, paneId: spawn.paneId, sessionId: spawn.child.sessionId,
    sessionFile: spawn.child.sessionFile, status: spawn.status };
}

async function startSupervisor(root, socketPath, ctx, parent, scope, allowed) {
  await ensureRoot(root);
  const id = randomUUID();
  const pendingPath = join(root, 'supervisor-start-pending.json');
  const path = join(root, `supervisor-start-${id}.json`);
  if (!allowed() || !sameSession(currentSession(ctx), parent))
    refuse('Planning session changed before supervisor creation');
  try { await claim(pendingPath, { token: id, parent: parent.sessionId, scope }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pending = await readJson(pendingPath);
    refuse(`Supervisor startup ${pending.token} is unresolved; inspect before creating another space`);
  }
  const intent = { id, parent, scope, cwd: await realpath(ctx.cwd), status: 'workspace-requested' };
  await claim(path, intent);
  try {
    if (!allowed() || !sameSession(currentSession(ctx), parent))
      refuse('Planning session changed before supervisor creation');
    const created = await request(socketPath, 'workspace.create', { cwd: intent.cwd,
      label: 'Continuation Supervisor', focus: false,
      env: { PI_CONTINUATION_SUPERVISOR_START: id, PI_CONTINUATION_ROOT: root } });
    const pane = created.root_pane;
    if (created.type !== 'workspace_created' || !pane?.pane_id || !pane.terminal_id ||
        pane.workspace_id !== created.workspace?.workspace_id || pane.workspace_id === parent.workspaceId)
      refuse('Supervisor space creation identity uncertain');
    await atomicJson(path, { ...intent, status: 'start-requested', pane });
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const deadline = performance.now() + 10000;
      while (true) {
        const result = await request(socketPath, 'pane.process_info', { pane_id: pane.pane_id });
        const info = result.process_info;
        if (result.type !== 'pane_process_info' || info?.pane_id !== pane.pane_id)
          refuse('Supervisor shell readiness unavailable');
        if (info.shell_pid > 0 && info.foreground_process_group_id === info.shell_pid &&
            info.foreground_processes?.length === 1 && info.foreground_processes[0].pid === info.shell_pid) break;
        if (performance.now() >= deadline) refuse('Supervisor shell did not become ready');
        await delay(150);
      }
    }
    const name = `pcs-${BigInt(`0x${id.replaceAll('-', '')}`).toString(36)}`;
    const started = await request(socketPath, 'agent.start', { name, kind: 'pi',
      pane_id: pane.pane_id, args: [], timeout_ms: 30000 }, { timeoutMs: 35000 });
    if (started.type !== 'agent_started') refuse('Supervisor Pi startup was not acknowledged');
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      const attempt = await readJson(path);
      if (attempt.status === 'held') refuse(attempt.failure);
      if (attempt.status === 'ready') {
        const state = await readSupervisor(root);
        const live = await snapshot(socketPath);
        const binding = { paneId: pane.pane_id, terminalId: pane.terminal_id,
          workspaceId: pane.workspace_id, tabId: pane.tab_id, cwd: intent.cwd,
          sessionKind: 'path', sessionValue: attempt.sessionFile };
        if (state.supervisorSession === attempt.sessionId && state.acceptStarts && !state.paused &&
            sameOccupant(live.agents.find(agent => agent.pane_id === pane.pane_id), binding) &&
            await ownerAlive(root, state.ownerToken)) {
          await release(pendingPath, id);
          return state;
        }
      }
      await delay(150);
    }
    refuse('Supervisor identity or readiness could not be verified');
  } catch (error) {
    throw new Error(`Supervisor startup ${id} held for inspection (${error.message}); do not retry under another scope`);
  }
}

export function bindDelegation(pi, worker, { root = defaultRoot(), socketPath = process.env.HERDR_SOCKET_PATH,
  paneId = process.env.HERDR_PANE_ID, delegationId = process.env.PI_CONTINUATION_SPAWN, registerOwner, replaceOwner } = {}) {
  async function adoptRetainedAssignment(action, ctx, prior) {
    if (!isId(action.id) || action.workerId !== prior.workerId) return { accepted: false };
    const ticket = await readJson(spawnPath(root, action.id));
    const state = await readSupervisor(root);
    const next = state.workers[ticket.workerId];
    const retired = state.retiredWorkers[prior.workerId];
    const closed = state.closedAssignments[ticket.replacesGrant];
    const transition = state.retainedAssignments[ticket.grantId];
    const expected = ticket.role === 'owner' ? transition?.ownerTicket : transition?.writerTicket;
    const live = await snapshot(socketPath);
    if (!expected || !isDeepStrictEqual(ticket, { ...expected, status: 'dispatching', ownerToken: state.ownerToken }) ||
        ticket.status !== 'dispatching' || ticket.replacesWorker !== prior.workerId ||
        !next || !retired || retired.retiredBy !== closed?.launchId || next.delegationId !== ticket.id ||
        next.sessionId !== prior.sessionId || next.sessionFile !== prior.sessionFile ||
        ticket.ownerToken !== state.ownerToken || state.paused || next.paused || state.routes[next.route]?.paused ||
        !sameOccupant(live.agents.find(a => a.pane_id === paneId), next)) return { accepted: false };
    const version = worker.interactionVersion;
    if (ticket.role === 'owner') await replaceOwner(ctx, prior.coordinatorId, next.coordinatorId);
    await worker.adoptRetained(ctx, prior, next, () => version === worker.interactionVersion);
    pi.appendEntry('pi-continuation-delegation', { grantId: ticket.grantId, spawnId: ticket.id,
      sessionId: next.sessionId });
    const role = ticket.role === 'owner' ? 'Non-writing coordinating owner and user inbox. ' +
      `The existing writer (${transition.writerTicket.workerId}) already received this scope. ` +
      'Wait for that writer; do not spawn another. Use independent review and follow current delivery preferences and required decision gates. ' +
      'Use continuation_assignment_delivered only after actual review and all applicable delivery obligations.' :
      'Implementation writer.';
    await worker.dispatchDelegated(ctx, ticket,
      `New approved assignment. Previous assignments and approvals do not carry forward.\n${role}\n\n${ticket.task}\n\n${delegationInstructions}`);
    return { accepted: true, id: ticket.id };
  }
  let retaining = false;
  worker.onRetainedAssignment(async (...args) => {
    if (retaining) return { accepted: false };
    retaining = true;
    try { return await adoptRetainedAssignment(...args); }
    finally { retaining = false; }
  });
  let closeBootstrap;
  let stopInput;
  let generation = 0;
  const reference = ctx => ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
    e.customType === 'pi-continuation-delegation' && e.data?.sessionId === currentSession(ctx).id).at(-1)?.data;
  async function launch(argument, ctx, { parallelChat = false } = {}) {
    const input = argument.trim();
    const explicitSpace = input === '--new-space' || input.startsWith('--new-space -- ') ? 'new' : undefined;
    let scope = input === '--new-space' ? '' :
      explicitSpace ? input.slice('--new-space -- '.length).trim() : input;
    let assignment = scope;
    if (ctx.mode !== 'tui' || process.env.HERDR_ENV !== '1' || !socketPath || !paneId || !ctx.isIdle() ||
        Buffer.byteLength(scope) > 8000)
      refuse('Use /start-implementation [agreed scope] in an idle Herdr Pi TUI (up to 8000 UTF-8 bytes)');
    const version = generation;
    const session = currentSession(ctx);
    const commandEvidence = worker.launchEvidence(ctx);
    const allowed = () => generation === version && ctx.isIdle() &&
      (!worker.hold || (commandEvidence && isDeepStrictEqual(worker.launchEvidence(ctx), commandEvidence))) &&
      !worker.promptBlocked && currentSession(ctx).leaf === session.leaf;
    const cwd = await realpath(ctx.cwd);
    let pending;
    try { pending = await readJson(join(root, 'supervisor-start-pending.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending !== undefined)
      refuse(`Supervisor startup ${pending?.token ?? 'unknown'} is unresolved; inspect before launching an owner`);
    let state;
    try { state = await readSupervisor(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = newSupervisor(); }
    let ownerLive = !!state.ownerToken && await ownerAlive(root, state.ownerToken);
    if (parallelChat && ownerLive && (state.paused || !state.acceptStarts))
      refuse('The supervisor is paused. A chat request does not lift that pause.');
    if (!ownerLive) {
      let lock;
      try { lock = await readJson(join(root, 'supervisor.lock')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (lock) refuse('Retained supervisor lock needs exact ownership reconciliation before replacement');
    }
    if (state.paused && (state.failure ||
        (state.acceptStarts && state.reason !== 'Explicit global pause') ||
        (!state.acceptStarts && state.reason && state.reason !== 'Explicit global pause')))
      refuse('Supervisor fault or unknown pause requires inspection before launch');
    const activateForLaunch = async () => {
      if (!ownerLive) {
        state = await startSupervisor(root, socketPath, ctx, grant.parent, scope, allowed);
        ownerLive = true;
        grant.ownerToken = state.ownerToken;
        grant.supervisorSession = state.supervisorSession;
        return;
      }
      if (!state.paused && state.acceptStarts) return;
      const activation = await sendAction(root, { type: 'launch-activate', ownerToken: state.ownerToken },
        'supervisor');
      if (!activation.accepted || activation.ownerToken !== state.ownerToken)
        refuse(activation.message ?? 'Supervisor could not resume for this implementation');
      state = await readSupervisor(root);
    };
    const grant = { id: randomUUID(), cwd, originCwd: cwd, role: 'writer', ownerLaunch: true,
      ownerToken: state.ownerToken, supervisorSession: state.supervisorSession, revoked: false };
    const live = await snapshot(socketPath);
    grant.parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), session, ctx.cwd);
    const originOwner = Object.values(state.workers).find(w => w.sessionId === session.id || w.sessionFile === session.file);
    if (!allowed() || !sameSession(currentSession(ctx), grant.parent) || state.supervisorSession === session.id ||
        (originOwner && (originOwner.role !== 'owner' || !sameOccupant(live.agents.find(a => a.pane_id === paneId), originOwner))))
      refuse('Launch requires an unchanged planner or exact coordinating owner');
    requireDelegationParent(live, grant.parent);
    if (state.routes[grant.parent.workspaceId]?.paused) refuse('Delegation route is paused');
    if (!scope) {
      const signal = AbortSignal.timeout(45000);
      let agreed;
      try { agreed = await agreedLaunchScope(ctx, signal); }
      catch { refuse('Could not read the agreed plan with the configured model. No owner launched.'); }
      scope = agreed?.scope;
      assignment = agreed?.assignment;
      if (!scope || signal.aborted)
        refuse('No single agreed assignment found. Clarify which plan to hand off, then run /start-implementation.');
      if (!allowed() || !sameSession(currentSession(ctx), grant.parent))
        refuse('Planning session changed while reading the plan; no owner launched');
    }
    grant.scope = scope;
    grant.deliveryPreferences = await readDeliveryPreferences(root);
    const options = launchOptions(assignment);
    if (explicitSpace && options.space && options.space !== explicitSpace)
      refuse('Conflicting space placement options');
    options.space = explicitSpace ?? options.space;
    const checkout = await launchCheckout(ctx, options.worktree ?
      `${options.assignment} ${options.worktree.repository}` : options.assignment,
      (title, choices) => worker.selectManagement(ctx, title, choices), options.space);
    const target = checkout.checkout;
    const pendingRetained = Object.values(state.retainedAssignments ?? {}).find(item =>
      item.oldClaim.grantId === options.closeAssignment && item.grant.scope === options.assignment);
    const nextQueued = state.assignmentQueues[options.closeAssignment]?.[0];
    if (options.closeAssignment && !originOwner && !options.worktree && !options.space &&
        (nextQueued?.scope === options.assignment || pendingRetained)) {
      if (!allowed()) refuse('Planning session changed; no retained assignment started');
      const result = await sendAction(root, { type: 'assignment-retained-start', grantId: options.closeAssignment,
        scope: options.assignment, planner: grant.parent, ownerToken: state.ownerToken }, 'supervisor', { timeoutMs: 45000 });
      if (!result.accepted) refuse(result.message ?? 'Retained assignment start not confirmed');
      ctx.ui.notify('Queued assignment started in the existing owner and writer panes.', 'info');
      return;
    }
    const preflight = await recoverPreflight(root, target, scope, grant.parent, state);
    const confirmed = preflight && confirmedRetryAbandonment(preflight.grant, preflight.attempt) ? preflight.grant : undefined;
    const recoveredClose = await recordedCloseout(root, target, scope, grant.parent, state);
    const retained = recoveredClose?.grant ?? confirmed;
    if (retained && (options.worktree || (options.closeAssignment && options.closeAssignment !== retained.closeAssignment)))
      refuse('Previous closeout belongs to another assignment or checkout');
    let closing = retained?.closeAssignment ?? options.closeAssignment;
    if (confirmed) grant.abandonAssignment = true;
    if (originOwner) {
      if (closing && closing !== originOwner.coordinatorId) refuse('Only this exact owner assignment may be closed');
      closing = originOwner.coordinatorId;
    }
    if (!closing && !options.worktree && !parallelChat) {
      try {
        const claim = await readJson(writerClaimPath(root, target));
        await closeoutCandidate(root, target, claim.grantId, state, live,
          id => request(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), commandEvidence);
        closing = claim.grantId;
      } catch { /* An ineligible assignment retains the ordinary worktree/owner refusal. */ }
      if (!closing) {
        try {
          const legacy = await commonDirectory(target);
          if (legacy !== target) {
            const claim = await readJson(writerClaimPath(root, legacy));
            await abandonmentCandidate(root, target, claim.grantId, state, live,
              id => request(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath));
            closing = claim.grantId;
            grant.abandonAssignment = true;
          }
        } catch (error) {
          if (error.code === 'UNRESOLVED_CHECKOUT_LAUNCH') throw error;
          // Other unverified historical claims retain the ordinary refusal.
        }
      }
    }
    if (closing && !recoveredClose && !grant.abandonAssignment) {
      try {
        await closeoutCandidate(root, target, closing, state, live,
          id => request(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath), commandEvidence);
      } catch (closeError) {
        if (!options.closeAssignment || commandEvidence) throw closeError;
        await abandonmentCandidate(root, target, closing, state, live,
          id => request(socketPath, 'pane.get', { pane_id: id }), () => snapshot(socketPath));
        grant.abandonAssignment = true;
      }
    }
    const queueInstead = parallelChat && !options.worktree ? async conflict => {
      const current = currentSession(ctx);
      const result = await sendAction(root, { type: 'assignment-enqueue', planner: grant.parent,
        text: options.assignment, conflict, leaf: current.leaf }, 'supervisor');
      if (!result.accepted) refuse(result.message ?? 'Queue request not confirmed');
      ctx.ui.notify(`Queued in position ${result.position}. The current assignment is unchanged.`, 'info');
    } : undefined;
    const placement = closing ? { cwd: target, space: options.space ?? checkout.space ?? 'current' } :
      await worktreeForLiveWriter(root, socketPath, state, live, target, scope, ctx, worker,
        grant.parent, allowed, options.worktree, options.space ?? checkout.space, activateForLaunch, queueInstead);
    if (!placement) return;
    grant.closeAssignment = closing;
    grant.abandonAssignment = recoveredClose?.grant.abandonAssignment ?? grant.abandonAssignment;
    grant.closeExplicit = recoveredClose?.grant.closeExplicit ?? !!options.closeAssignment;
    grant.cwd = placement.cwd;
    grant.space = placement.space;
    grant.worktreeCreated = grant.cwd !== target;
    grant.checkout = await checkoutIdentity(grant.cwd);
    if (!allowed() || !sameSession(currentSession(ctx), grant.parent))
      refuse('Planning session changed while choosing checkout; no owner launched');
    await activateForLaunch();
    await delegationOwner(root, grant);
    const scopePath = closeoutScopePath(root, grant.checkout, scope);
    let retryAbandonAssignment;
    try {
      await claim(scopePath, { grantId: grant.id });
      await claim(grantPath(root, grant.id), grant);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readJson(scopePath);
      const previous = await readJson(grantPath(root, existing.grantId));
      const key = digest(`${previous.id}\nassignment-owner`);
      const keyed = await readJson(join(root, `spawn-key-${key}.json`));
      const attempt = await readJson(spawnPath(root, keyed.id));
      if (previous.scope !== scope || previous.checkout !== grant.checkout ||
          previous.cwd !== grant.cwd || previous.originCwd !== grant.originCwd ||
          previous.ownerToken !== grant.ownerToken || previous.worktreeCreated ||
          previous.space !== grant.space || !isDeepStrictEqual(previous.parent, grant.parent) ||
          (attempt.status !== 'preflight-refused' &&
            (!recoveredClose || attempt.id !== recoveredClose.attempt.id)) || attempt.grantId !== previous.id)
        refuse('Prior owner launch has no proved pre-effect refusal; inspect before retrying');
      if (grant.abandonAssignment && !previous.closeAssignment) retryAbandonAssignment = grant.closeAssignment;
      grant.id = previous.id;
    }
    const result = await spawnDelegated({ root, socketPath, paneId, ctx, reference: { grantId: grant.id },
      task: scope, role: 'owner', key: 'assignment-owner', ownerLaunch: true, retryAbandonAssignment, commandEvidence, allowed,
      selectApproval: (title, choices) => worker.selectManagement(ctx, title, choices) });
    ctx.ui.notify(`Coordinating owner started in ${result.paneId}. Continue this assignment in that pane.`, 'info');
  }
  let launching = false;
  pi.registerCommand('start-implementation', {
    description: 'Launch a supervised coordinating owner from the agreed chat plan or explicit scope',
    handler: async (argument, ctx) => {
      if (launching) refuse('An implementation start is already in progress');
      launching = true;
      try { await launch(argument, ctx); }
      finally { launching = false; }
    },
  });
  pi.registerCommand('continuation-delegate', {
    description: 'Authorize scoped delegation: <writer|read-only> <scope> | revoke | recover-reviewers',
    handler: async (argument, ctx) => {
      if (ctx.mode !== 'tui' || !socketPath || !paneId || !ctx.isIdle()) refuse('Idle Herdr Pi TUI required');
      await ensureRoot(root);
      if (argument.trim() === 'revoke') {
        const ref = reference(ctx);
        if (!ref) refuse('No scope to revoke');
        const grant = await readJson(grantPath(root, ref.grantId));
        const source = ref.spawnId && grant.ownerLaunch ? await readJson(spawnPath(root, ref.spawnId)) : undefined;
        const binding = !ref.spawnId ? grant.parent : source?.role === 'owner' && source.grantId === grant.id ? source.child : undefined;
        if (!binding || !sameSession(currentSession(ctx), binding) || paneId !== binding.paneId)
          refuse('Revoke in the originating session or the launched coordinating owner');
        grant.revoked = true;
        await atomicJson(grantPath(root, grant.id), grant);
        ctx.ui.notify('Delegation revoked for this tree; existing workers and scope pauses are unchanged', 'info');
        return;
      }
      if (argument.trim() === 'recover-reviewers') {
        const ref = reference(ctx);
        if (!ref?.spawnId) refuse('Run reviewer recovery in the exact surviving coordinating owner');
        await worker.flushObservations();
        const version = generation;
        const evidence = worker.launchEvidence(ctx);
        const session = currentSession(ctx);
        const candidate = async () => {
          if (generation !== version || !ctx.isIdle() || worker.promptBlocked ||
              !isDeepStrictEqual(currentSession(ctx), session) ||
              (worker.hold && (!evidence || !isDeepStrictEqual(worker.launchEvidence(ctx), evidence))))
            refuse('Owner interaction or hold changed during reviewer recovery');
          const live = await snapshot(socketPath);
          const parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), currentSession(ctx), ctx.cwd);
          requireDelegationParent(live, parent, true);
          const authority = await delegationAuthority(root, ref, parent, evidence, true);
          await requireSettledRecoveryEffects(root, authority);
          return authority;
        };
        const { grant, recovery } = await candidate();
        const path = reviewerRecoveryPath(root, recovery);
        const existing = await optionalRecord(path);
        if (existing) {
          if (!isDeepStrictEqual(existing, recovery)) refuse('Existing reviewer recovery evidence does not match');
          ctx.ui.notify('Reviewer-only delegation is already restored for this supervisor.', 'info');
          return;
        }
        if (!await worker.confirmDelegation(ctx, 'Restore read-only reviewer delegation?',
          `Assignment ${grant.id}: ${grant.scope}\nEnded supervisor ${recovery.previousSession}\n` +
          `Predecessor ${recovery.predecessor.sessionId}\nReplacement ${recovery.supervisorSession}\n` +
          'No writer authority, pause, wait or prior attempt will change.')) return;
        const final = await candidate();
        if (!isDeepStrictEqual(grant, final.grant) || !isDeepStrictEqual(recovery, final.recovery) ||
            generation !== version || !ctx.isIdle() || worker.promptBlocked ||
            !isDeepStrictEqual(currentSession(ctx), session))
          refuse('Assignment or supervisor evidence changed during confirmation');
        await claim(path, recovery);
        ctx.ui.notify('Read-only reviewer delegation restored for this supervisor. Writer delegation remains unavailable.', 'info');
        return;
      }
      const existing = reference(ctx);
      if (existing && !existing.spawnId && !(await readJson(grantPath(root, existing.grantId))).revoked)
        refuse('Revoke the current delegation tree before authorizing another scope in this planning session');
      if (existing?.spawnId) {
        const inherited = await readJson(grantPath(root, existing.grantId));
        if (inherited.ownerLaunch && (await readSupervisor(root)).ownerToken !== inherited.ownerToken)
          refuse('Stale assignment authority cannot be replaced here; only recover-reviewers is available');
      }
      const [role, ...words] = argument.trim().split(/\s+/);
      const scope = words.join(' ');
      if (!['writer', 'read-only'].includes(role) || !scope || Buffer.byteLength(scope) > 8000)
        refuse('Explicit writer/read-only role and bounded assignment scope required');
      const checkout = role === 'writer' ? await checkoutIdentity(ctx.cwd) : undefined;
      const state = await readSupervisor(root);
      await delegationOwner(root, { ownerToken: state.ownerToken, supervisorSession: state.supervisorSession });
      const live = await snapshot(socketPath);
      const parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), currentSession(ctx), ctx.cwd);
      if (state.routes[parent.workspaceId]?.paused) refuse('Route is paused');
      const version = generation;
      if (!await worker.confirmDelegation(ctx, 'Authorize scoped supervised delegation?', `Role ceiling: ${role}\nScope: ${scope}\nCwd: ${ctx.cwd}\nSupervisor session: ${state.supervisorSession}\n\n${delegationInstructions}\n` +
          'Authorize this session and its new workers to delegate within this scope to the current running supervisor. No per-worker enrollment confirmation. You retain independent pauses.')) return;
      if (generation !== version || !ctx.isIdle() || !sameSession(currentSession(ctx), parent))
        refuse('Session changed during delegation authorization');
      const id = randomUUID();
      const grant = { id, parent, cwd: await realpath(ctx.cwd), scope, role, checkout, ownerToken: state.ownerToken,
        supervisorSession: state.supervisorSession, revoked: false };
      await delegationOwner(root, grant);
      await claim(grantPath(root, id), grant);
      pi.appendEntry('pi-continuation-delegation', { grantId: id, sessionId: parent.sessionId });
      ctx.ui.notify('Scoped delegation authorized; this planning session need not enroll as a worker', 'info');
    },
  });
  pi.registerTool({
    name: 'continuation_spawn', label: 'Delegate supervised worker', executionMode: 'sequential',
    description: 'Create one new Herdr Pi worker, verify its saved-session identity, enroll with the intended running supervisor BEFORE sending its assignment. Requires a human /continuation-delegate scope grant or inherited delegated grant. Stable key identifies one assignment; rejected/uncertain attempts are held, never blindly retry or change the key. Does not create supervisors or activate paused scopes.',
    promptGuidelines: [delegationInstructions, 'Use continuation_spawn only for explicitly authorized delegation, never brainstorming. Keep the same key for an assignment; inspect held attempts instead of retrying.'],
    parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 120 }),
      task: Type.String({ minLength: 1, maxLength: 16000 }), role: Type.Union([Type.Literal('writer'), Type.Literal('read-only')]) }),
    execute: async (_call, args, signal, _update, ctx) => {
      if (ctx.mode !== 'tui' || !socketPath || !paneId) refuse('Herdr Pi TUI required');
      const version = generation;
      const ref = reference(ctx);
      if (!ref) refuse('No scoped delegation grant; brainstorming or tool text is not delegation authority');
      const result = await spawnDelegated({ root, socketPath, paneId, ctx, reference: ref, ...args, signal,
        allowed: () => generation === version && !worker.hold && !worker.promptBlocked });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  let queueInput;
  let queueTurn;
  const parallelScope = text => /^start ([^\r\n]+) separately[.!]?$/i.exec(text?.trim() ?? '')?.[1]?.trim();
  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension') generation++;
    queueInput = queueTurn = undefined;
    if (event.source === 'interactive' && ctx.mode === 'tui' && ctx.isIdle() && socketPath && paneId &&
        process.env.HERDR_ENV === '1' && !worker.registered &&
        (queueRequest(event.text) || parallelScope(event.text))) queueInput = event.text;
  });
  pi.on('before_agent_start', event => {
    queueTurn = event.messageType === 'user' && event.prompt === queueInput ? queueInput : undefined;
    queueInput = undefined;
    if (queueTurn) return { message: { customType: 'pi-continuation-planning-request', display: false,
      content: 'Pi will process this exact planning request after the turn and show the result. ' +
        'Do not launch an agent or claim the work is queued or started yourself.' } };
  });
  pi.on('agent_settled', async (event, ctx) => {
    const text = queueTurn;
    queueInput = queueTurn = undefined;
    if (!text || event.aborted || worker.registered || worker.promptBlocked) return;
    const session = currentSession(ctx);
    const version = generation;
    const lastReply = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' &&
      entry.message?.role === 'assistant');
    if (!lastReply || lastReply.message.stopReason !== 'stop' || !session.leaf) return;
    const separately = parallelScope(text);
    if (separately) {
      if (launching) return;
      launching = true;
      try {
        if (separately.startsWith('--')) refuse('Write the agreed scope as ordinary text; use the launch command for options');
        await launch(separately, ctx, { parallelChat: true });
      } catch (error) { ctx.ui.notify(error.message, 'warning'); }
      finally { launching = false; }
      return;
    }
    try {
      const live = await snapshot(socketPath);
      const planner = nativeBinding(live.agents.find(a => a.pane_id === paneId), session, ctx.cwd);
      if (generation !== version || worker.promptBlocked || !isDeepStrictEqual(session, currentSession(ctx)))
        refuse('Planning session changed; nothing was queued');
      const result = await sendAction(root, { type: 'assignment-enqueue', planner, text, leaf: session.leaf }, 'supervisor');
      ctx.ui.notify(result.accepted ? `Queued in position ${result.position}. The current assignment is unchanged.` :
        result.message, result.accepted ? 'info' : 'warning');
    } catch {
      ctx.ui.notify('Could not confirm the backlog entry. Check the supervisor before sending the request again.', 'warning');
    }
  });
  pi.on('ui_prompt_start', () => { if (!worker.confirming) generation++; });
  pi.on('session_start', async (event, ctx) => {
    generation++;
    stopInput?.();
    if (ctx.mode === 'tui' && paneId && socketPath) stopInput = ctx.ui.onTerminalInput?.(data => {
      if (!worker.confirming || data === '\u001b') generation++;
    });
    if (!isId(delegationId) || event.reason !== 'startup' || ctx.mode !== 'tui' || !paneId || !socketPath) return;
    const bootstrapVersion = generation;
    const spawn = await readJson(spawnPath(root, delegationId));
    if (spawn.status !== 'starting' || spawn.paneId !== paneId || spawn.child || worker.registered ||
        ctx.sessionManager.getEntries().some(e => e.type === 'message' || e.customType === 'pi-continuation-worker'))
      refuse('Delegated startup must be a new blank Pi session in only its created pane');
    let busy = false;
    closeBootstrap = await listenJson(root, delegationId, async action => {
      if (busy || action.id !== delegationId) return { accepted: false };
      busy = true;
      try {
        const ticket = await readJson(spawnPath(root, delegationId));
        if (generation !== bootstrapVersion || worker.promptBlocked || worker.hold)
          refuse('Delegated startup interrupted; inspect instead of enrolling or delivering a task');
        if (ticket.paneId !== paneId || ticket.terminalId !== spawn.terminalId ||
            (ticket.child && !sameSession(currentSession(ctx), ticket.child))) refuse('Delegated child identity changed');
        if (action.type === 'hello' && ticket.status === 'starting')
          return { accepted: true, id: delegationId, session: currentSession(ctx) };
        if (action.type === 'enroll' && ticket.status === 'enrolling') {
          if (ticket.role === 'owner') {
            const grant = await readJson(grantPath(root, ticket.grantId));
            if (!grant.ownerLaunch || ticket.authority?.spawnId || !registerOwner)
              refuse('Exact one-command owner launch required');
            const { state } = await delegationAuthority(root, ticket.authority, ticket.parent);
            if (state.routes[ticket.child.workspaceId]?.paused) refuse('Delegation route is paused');
            const live = await snapshot(socketPath);
            requireDelegationParent(live, ticket.parent);
            if (!sameOccupant(live.agents.find(a => a.pane_id === paneId), ticket.child) ||
                generation !== bootstrapVersion || worker.promptBlocked || worker.hold)
              refuse('Owner startup interrupted or identity changed');
            await registerOwner(ctx, grant.id);
          }
          await worker.enrollDelegated(ctx, ticket, () => generation === bootstrapVersion);
          const { state, ownerToken } = await delegationAuthority(root, ticket.authority, ticket.parent);
          if (ownerToken !== ticket.ownerToken) refuse('Delegated enrollment supervisor changed');
          const binding = Object.values(state.workers).find(w => w.sessionId === ticket.child.sessionId);
          if (!binding || binding.lastStartNonce !== ticket.id || binding.paused) refuse('Delegated worker did not join');
          pi.appendEntry('pi-continuation-delegation', { grantId: ticket.grantId, spawnId: ticket.id,
            sessionId: ticket.child.sessionId });
          return { accepted: true, id: ticket.id, workerId: binding.workerId };
        }
        if (action.type === 'assignment' && ticket.status === 'dispatching') {
          const fresh = await snapshot(socketPath);
          const authority = await delegationAuthority(root, ticket.authority, ticket.parent);
          const { grant, state, role, ownerToken, recovery } = authority;
          if (ownerToken !== ticket.ownerToken || (ticket.role === 'writer' && role === 'read-only'))
            refuse('Assignment delegation authority changed');
          const binding = state.workers[ticket.workerId];
          requireDelegationParent(fresh, ticket.parent, !!recovery);
          if (!binding || binding.paused || state.routes[binding.route]?.paused ||
              !sameOccupant(fresh.agents.find(a => a.pane_id === paneId), binding)) refuse('Assignment scope/identity changed');
          if (recovery) await requireSettledRecoveryEffects(root, authority, ticket.id);
          const preferences = ticket.role === 'owner' ? await readAssignmentDeliveryPreferences(root, grant) : undefined;
          const delivery = preferences ? deliveryFields.map(field =>
            `${field.label}: ${preferences[field.key]}`).join('\n') : '';
          const message = ticket.role === 'owner' ?
            `Approved assignment for this supervised coordinating owner (not the writer):\n${grant.scope}\n\n` +
            `Delivery preferences for this assignment:\n${delivery}\n` +
            `${reviewFixPreferenceGuidance} These choices do not grant Git publication or override independent review. ` +
            'Ask First never skips mandatory review. PR Automatic cannot bypass Push Off without an eligible remote branch. ' +
            'Close review panes only for this assignment’s exact temporary reviewers after selected fixes are independently verified. ' +
            'Use /continuation → This assignment: delivery to inspect or explicitly change these choices. ' +
            'Read continuation_delivery_preferences for current choices before review, resolving findings, push, PR or reviewer closure.\n' +
            'Use the implementation-owner skill when available. You are the permanent user inbox, not the brainstorming session. ' +
            'Use continuation_spawn to start the sole writer and scoped read-only reviewers, retaining them for selected fixes and verification. ' +
            'Use continuation_owner_wait for child results or a real user decision. Initiate independent review after implementation; follow the owner workflow and all applicable human-selection rules. ' +
            'Create the PR only where authorized after verification. After actual independent review and all applicable delivery obligations, ' +
            'use continuation_assignment_delivered with the final revision and concrete outcomes. Do not treat a writer report or an unverified fix as delivery. ' +
            'Send no assignment notices to the brainstorming session.\n' + delegationInstructions :
            `Approved delegation scope:\n${grant.scope}\n\nRole: ${ticket.role}.\n${delegationInstructions}\n\nAssignment:\n${ticket.task}`;
          await worker.dispatchDelegated(ctx, ticket, message);
          return { accepted: true, id: ticket.id };
        }
        return { accepted: false };
      } finally { busy = false; }
    }, () => {});
  });
  pi.on('session_shutdown', async () => {
    generation++; stopInput?.(); stopInput = undefined;
    queueInput = queueTurn = undefined;
    await closeBootstrap?.(); closeBootstrap = undefined;
  });
}
