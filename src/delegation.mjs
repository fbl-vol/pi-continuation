import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from 'typebox';
import { atomicJson, claim, defaultRoot, ensureRoot, readJson, release } from './store.mjs';
import { isId, newSupervisor, readObservation, readSupervisor } from './contracts.mjs';
import { deliveryFields, effectiveDeliveryPreferences, readAssignmentDeliveryPreferences,
  readDeliveryPreferences } from './preferences.mjs';
import { currentSession } from './session.mjs';
import { agreedLaunchScope } from './checkpoint.mjs';
import { isSettled, request, sameOccupant, snapshot } from './herdr.mjs';
import { listenJson, ownerAlive, sendAction } from './ipc.mjs';

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
const ownerLaunchPath = (root, checkout) => join(root, `owner-launch-pending-${digest(checkout)}.json`);

async function worktreeForLiveWriter(root, socketPath, state, live, target, scope, ctx, worker, parent, allowed,
  authorizedWorktree, explicitSpace, readyForCreate) {
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
    if (tree === target && (binding.role !== 'owner' || binding.paused ||
        state.ownerWaits[binding.workerId] || state.inflight[binding.workerId] ||
        state.dispositions[binding.workerId]?.action === 'decision' ||
        Object.values(state.notices).some(n => n.recipient?.id === binding.coordinatorId && unresolvedNotice(n))))
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
  for (const path of new Set([writerClaimPath(root, target), writerClaimPath(root, common)])) {
    let claimRecord;
    try { claimRecord = await readJson(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!active.some(binding => binding.delegationId === claimRecord.id))
      refuse('Writer claim is not accounted for by the live writer; inspect before choosing another worktree');
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
    const title = `Create a separate worktree for this assignment?\nRepository: ${target}\n` +
      `Base: ${base}\nBranch: ${branch}\nPath: ${path}`;
    const choices = explicitSpace ? ['Create this worktree', 'Cancel'] :
      ['Create in current space', 'Create in new space', 'Cancel'];
    const choice = await worker.selectManagement(ctx, title, choices);
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

async function claimOwnerLaunch(path, id) {
  try { await claim(path, { token: id }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pending = await readJson(path).catch(() => undefined);
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
      Object.keys(options).some(key => !['worktree', 'space'].includes(key)) ||
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

export function requireDelegationParent(live, parent) {
  const agent = live.agents.find(a => a.pane_id === parent?.paneId);
  if (!sameOccupant(agent, parent) || !['idle', 'working', 'done'].includes(agent.agent_status))
    refuse('Parent Herdr identity/status changed or blocked');
}

export async function delegationOwner(root, grant) {
  const state = await readSupervisor(root);
  if (!state.acceptStarts || state.ownerToken !== grant.ownerToken ||
      state.supervisorSession !== grant.supervisorSession || !await ownerAlive(root, grant.ownerToken))
    refuse('Intended running supervisor changed or is unavailable; no replacement will be created');
  if (state.paused) refuse('Global continuation is paused');
  return state;
}

export async function delegationAuthority(root, reference, binding) {
  const grant = await readJson(grantPath(root, reference?.grantId));
  if (grant.revoked || (reference.spawnId ? grant.cwd : grant.originCwd ?? grant.cwd) !== await realpath(binding.cwd))
    refuse('Delegation scope revoked or cwd changed');
  let role = grant.role;
  if (!['writer', 'read-only'].includes(role)) refuse('Delegation has no explicit role boundary');
  let inheritedRecipient;
  if (reference.spawnId) {
    const parent = await readJson(spawnPath(root, reference.spawnId));
    const launchOwner = grant.ownerLaunch && parent.role === 'owner';
    if (parent.grantId !== grant.id || (grant.ownerLaunch ? !launchOwner : !['writer', 'read-only'].includes(parent.role)) ||
        parent.status !== 'dispatched' || JSON.stringify(parent.child) !== JSON.stringify(binding))
      refuse('Subdelegation parent is not the dispatched exact child with delegation authority');
    role = launchOwner ? 'writer' : grant.role === 'read-only' ? 'read-only' : parent.role;
    inheritedRecipient = parent.recipient;
  } else if (JSON.stringify(grant.parent) !== JSON.stringify(binding)) refuse('Delegation belongs to another planning session');
  const state = await delegationOwner(root, grant);
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
    if (reference.spawnId && worker?.role !== 'owner') refuse('Exact supervised coordinating owner required');
    if (!reference.spawnId && (state.supervisorSession === binding.sessionId ||
      Object.values(state.workers).some(w => w.sessionId === binding.sessionId || w.sessionFile === binding.sessionFile)))
      refuse('Launch requires an unsupervised planning session');
  }
  if (worker) {
    const observation = await readObservation(root, worker.workerId);
    if (['paneId', 'terminalId', 'workspaceId', 'tabId', 'sessionId', 'sessionFile', 'cwd']
      .some(key => binding[key] !== worker[key])) refuse('Parent worker identity changed');
    if (worker.paused || observation.hold || observation.session.id !== binding.sessionId ||
        observation.session.file !== binding.sessionFile) refuse('Parent worker is paused or held');
  }
  return { grant, state, role };
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
      grant.ownerToken !== state.ownerToken || grant.supervisorSession !== state.supervisorSession ||
      record.sessionId !== spawn.child?.sessionId || record.sessionFile !== spawn.child?.sessionFile ||
      record.paneId !== spawn.child?.paneId || record.cwd !== grant.cwd ||
      record.start?.nonce !== spawn.id || record.delegationId !== spawn.id || state.paused ||
      state.routes[spawn.child.workspaceId]?.paused || !sameOccupant(live.agents.find(a => a.pane_id === record.paneId), spawn.child))
    refuse('Delegated enrollment is not the newly created exact child under its active owner/scope');
  requireDelegationParent(live, spawn.parent);
  const authority = await delegationAuthority(root, spawn.authority, spawn.parent);
  if (authority.grant.id !== spawn.grantId || (spawn.role === 'writer' && authority.role === 'read-only'))
    refuse('Delegated enrollment exceeds inherited scope');
  if (Object.values(state.workers).some(w => w.paneId === record.paneId || w.sessionId === record.sessionId))
    refuse('Delegated enrollment cannot replace or reactivate an existing worker');
  if (spawn.recipient && (!state.workers[spawn.parentWorkerId] ||
      state.workers[spawn.parentWorkerId].recipient?.id !== spawn.recipient.id &&
      state.workers[spawn.parentWorkerId].coordinatorId !== spawn.recipient.id))
    refuse('Delegated owner recipient changed');
  return { ...spawn, displayLabel: delegatedDisplayLabel(spawn.role, grant) };
}

const unresolvedNotice = notice => ['pending', 'sending', 'uncertain'].includes(notice.status);

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

async function inspectCheckout(root, grant, parent, recipient, state, live, readPane, readSnapshot, recover) {
  if (!grant.checkout || await checkoutIdentity(grant.cwd, grant.checkout) !== grant.checkout)
    refuse('Delegation checkout identity changed');
  const pending = recover ? new Map() : undefined;
  const legacyGrant = grant.checkout !== await checkoutRoot(grant.cwd);
  for (const worker of Object.values(state.workers)) {
    const id = isId(worker.workerId) ? worker.workerId : '(invalid ID)';
    let checkout;
    try { checkout = legacyGrant ? await commonDirectory(worker.cwd) : await checkoutRoot(worker.cwd); }
    catch { refuse(`Existing worker checkout cannot be verified for ${id}; inspect writer ownership`); }
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
      if (blocker) refuse(`Checkout already has a supervised worker ${id}: ${blocker}; inspect writer ownership`);
    }
  }
  return pending;
}

const writerClaimPath = (root, checkout) => join(root, `delegation-writer-${digest(checkout)}.json`);
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
  signal, ownerLaunch = false, allowed = () => true, transport = request, readSnapshot = snapshot, send = sendAction }) {
  if (!(ownerLaunch ? role === 'owner' : ['writer', 'read-only'].includes(role)) || !task?.trim() || Buffer.byteLength(task) > 16000 ||
      !key?.trim() || key.length > 120) refuse('A stable assignment key, bounded task and writer/read-only role are required');
  const session = currentSession(ctx);
  const live = await readSnapshot(socketPath);
  const parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), session, ctx.cwd);
  const authority = await delegationAuthority(root, reference, parent);
  if (role === 'writer' && authority.role === 'read-only') refuse('Read-only delegates cannot create writers');
  if (ownerLaunch ? !authority.grant.ownerLaunch || reference.spawnId || task !== authority.grant.scope :
    authority.grant.ownerLaunch && !reference.spawnId) refuse('Owner launch requires the native start command');
  const checkLocal = () => {
    signal?.throwIfAborted();
    if (!allowed() || !sameSession(currentSession(ctx), parent)) refuse('Parent interaction/identity changed; inspect delegation');
  };
  const check = async () => {
    checkLocal();
    const state = (await delegationAuthority(root, reference, parent)).state;
    const fresh = await readSnapshot(socketPath);
    requireDelegationParent(fresh, parent);
    return { state, fresh };
  };
  await check();
  const attemptKey = digest(`${authority.grant.id}\n${key}`);
  const assignmentKey = digest(`${authority.grant.id}\n${task}`);
  const keyPath = join(root, `spawn-key-${attemptKey}.json`);
  const assignmentPath = join(root, `spawn-assignment-${assignmentKey}.json`);
  let id = randomUUID();
  let retry;
  if (ownerLaunch) {
    try {
      const keyed = await readJson(keyPath);
      const assigned = await readJson(assignmentPath);
      const previous = await readJson(spawnPath(root, keyed.id));
      if (assigned.id !== keyed.id || previous.id !== keyed.id ||
          previous.status !== 'preflight-refused' || previous.grantId !== authority.grant.id ||
          previous.key !== key || previous.task !== task || previous.role !== role ||
          previous.ownerToken !== authority.grant.ownerToken ||
          !isDeepStrictEqual(previous.parent, parent) || authority.grant.worktreeCreated)
        refuse('Prior owner launch has no proved pre-effect refusal; inspect before retrying');
      id = keyed.id;
      retry = previous;
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
  const recipient = parentWorker?.recipient ?? (parentWorker?.role === 'owner' ?
    { id: parentWorker.coordinatorId } : undefined);
  const spawn = retry ?? { id, grantId: authority.grant.id, authority: reference, ownerToken: authority.grant.ownerToken,
    parent, role, key, task, status: 'prepared', at: new Date().toISOString(),
    ...(recipient ? { recipient, parentWorkerId: parentWorker.workerId } : {}) };
  if (!retry) await claim(spawnPath(root, id), spawn);
  const save = async status => { spawn.status = status; await atomicJson(spawnPath(root, id), spawn); };
  const launchFence = ownerLaunch || role === 'writer' ? ownerLaunchPath(root, authority.grant.checkout) : undefined;
  const readPane = id => transport(socketPath, 'pane.get', { pane_id: id });
  const readLive = () => readSnapshot(socketPath);
  let fenceClaimed = false;
  let splitRequested = false;
  let dispatched = false;
  try {
    if (launchFence) {
      await claimOwnerLaunch(launchFence, id);
      fenceClaimed = true;
    }
    if (retry) await save('prepared');
    if (role === 'writer' || ownerLaunch) {
      const { state: current, fresh } = await check();
      const pending = await inspectCheckout(root, authority.grant, parent, recipient, current, fresh, readPane, readLive, ownerLaunch);
      if (ownerLaunch) {
        await requireNoWriterClaim(root, authority.grant.checkout, authority.grant.cwd);
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
    checkLocal();
    // From the first possible native effect until observed dispatch, retain the
    // checkout fence even if the response is lost or this process exits.
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
    if (ownerLaunch && !splitRequested && !authority.grant.worktreeCreated) {
      spawn.preflightFailures = [...(spawn.preflightFailures ?? []),
        { at: new Date().toISOString(), reason: error.message }];
      await save('preflight-refused');
    } else await save('held');
    if (ownerLaunch && !splitRequested)
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
  paneId = process.env.HERDR_PANE_ID, delegationId = process.env.PI_CONTINUATION_SPAWN, registerOwner } = {}) {
  let closeBootstrap;
  let stopInput;
  let generation = 0;
  const reference = ctx => ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
    e.customType === 'pi-continuation-delegation' && e.data?.sessionId === currentSession(ctx).id).at(-1)?.data;
  async function launch(argument, ctx) {
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
    const allowed = () => generation === version && ctx.isIdle() && !worker.hold && !worker.promptBlocked &&
      currentSession(ctx).leaf === session.leaf;
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
    if (!allowed() || !sameSession(currentSession(ctx), grant.parent) || state.supervisorSession === session.id ||
        Object.values(state.workers).some(w => w.sessionId === session.id || w.sessionFile === session.file))
      refuse('Launch requires an unchanged unsupervised planning session');
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
    const placement = await worktreeForLiveWriter(root, socketPath, state, live, target, scope, ctx, worker,
      grant.parent, allowed, options.worktree, options.space ?? checkout.space, activateForLaunch);
    grant.cwd = placement.cwd;
    grant.space = placement.space;
    grant.worktreeCreated = grant.cwd !== target;
    grant.checkout = await checkoutIdentity(grant.cwd);
    if (!allowed() || !sameSession(currentSession(ctx), grant.parent))
      refuse('Planning session changed while choosing checkout; no owner launched');
    await activateForLaunch();
    await delegationOwner(root, grant);
    const scopePath = join(root, `owner-launch-${digest(`${grant.checkout}\n${scope}`)}.json`);
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
          attempt.status !== 'preflight-refused' || attempt.grantId !== previous.id)
        refuse('Prior owner launch has no proved pre-effect refusal; inspect before retrying');
      grant.id = previous.id;
    }
    const result = await spawnDelegated({ root, socketPath, paneId, ctx, reference: { grantId: grant.id },
      task: scope, role: 'owner', key: 'assignment-owner', ownerLaunch: true, allowed });
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
    description: 'Authorize one scoped delegation tree: <writer|read-only> <assignment scope> | revoke',
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
      const existing = reference(ctx);
      if (existing && !existing.spawnId && !(await readJson(grantPath(root, existing.grantId))).revoked)
        refuse('Revoke the current delegation tree before authorizing another scope in this planning session');
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
  pi.on('input', event => { if (event.source !== 'extension') generation++; });
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
          const state = await delegationOwner(root, await readJson(grantPath(root, ticket.grantId)));
          const binding = Object.values(state.workers).find(w => w.sessionId === ticket.child.sessionId);
          if (!binding || binding.lastStartNonce !== ticket.id || binding.paused) refuse('Delegated worker did not join');
          pi.appendEntry('pi-continuation-delegation', { grantId: ticket.grantId, spawnId: ticket.id,
            sessionId: ticket.child.sessionId });
          return { accepted: true, id: ticket.id, workerId: binding.workerId };
        }
        if (action.type === 'assignment' && ticket.status === 'dispatching') {
          const grant = await readJson(grantPath(root, ticket.grantId));
          const state = await delegationOwner(root, grant);
          const binding = state.workers[ticket.workerId];
          const fresh = await snapshot(socketPath);
          requireDelegationParent(fresh, ticket.parent);
          if (!binding || binding.paused || state.routes[binding.route]?.paused ||
              !sameOccupant(fresh.agents.find(a => a.pane_id === paneId), binding)) refuse('Assignment scope/identity changed');
          await delegationAuthority(root, ticket.authority, ticket.parent);
          const preferences = ticket.role === 'owner' ? effectiveDeliveryPreferences(
            await readAssignmentDeliveryPreferences(root, grant)) : undefined;
          const delivery = preferences ? deliveryFields.map(field =>
            `${field.label}: ${preferences[field.key]}`).join('\n') : '';
          const message = ticket.role === 'owner' ?
            `Approved assignment for this supervised coordinating owner (not the writer):\n${grant.scope}\n\n` +
            `Effective delivery preferences for this assignment:\n${delivery}\n` +
            'These choices do not grant Git publication or override repository rules, user finding selection or independent review. ' +
            'Ask First never skips mandatory review. PR Automatic cannot bypass Push Off without an eligible remote branch. ' +
            'Close review panes only for this assignment’s exact temporary reviewers after selected fixes are independently verified. ' +
            'Use /continuation → This assignment: delivery to inspect or explicitly change these choices. ' +
            'Read continuation_delivery_preferences for the current effective choices before review, push, PR or reviewer closure.\n' +
            'Use the implementation-owner skill when available. You are the permanent user inbox, not the brainstorming session. ' +
            'Use continuation_spawn to start the sole writer and scoped read-only reviewers, retaining them for selected fixes and verification. ' +
            'Use continuation_owner_wait for child results or a real user decision. Initiate independent review after implementation; do not apply findings without user selection here. ' +
            'Create the PR only where authorized after verification. Send no assignment notices to the brainstorming session.\n' + delegationInstructions :
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
    await closeBootstrap?.(); closeBootstrap = undefined;
  });
}
