import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Type } from 'typebox';
import { atomicJson, claim, defaultRoot, ensureRoot, readJson, release } from './store.mjs';
import { isId, readObservation, readSupervisor } from './contracts.mjs';
import { currentSession } from './session.mjs';
import { agreedLaunchScope } from './checkpoint.mjs';
import { isSettled, request, sameOccupant, snapshot } from './herdr.mjs';
import { listenJson, ownerAlive, sendAction } from './ipc.mjs';

const exec = promisify(execFile);
async function checkoutIdentity(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 2500, maxBuffer: 8192, windowsHide: true });
    return await realpath(stdout.trim());
  } catch { refuse('Writer delegation requires a verifiable Git checkout (and Git on PATH)'); }
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
  if (grant.revoked || grant.cwd !== await realpath(binding.cwd)) refuse('Delegation scope revoked or cwd changed');
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
  const worker = Object.values(state.workers).find(w => w.sessionId === binding.sessionId || w.paneId === binding.paneId);
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
  return spawn;
}

// A missing agent is not enough: a shell pane can still exist or the session
// can be reported elsewhere. Ignore only closed, paused bindings with no
// unresolved delivery, leaving their records intact for historical inspection.
async function closedWorker(root, socketPath, worker, state, live, transport, readSnapshot) {
  const id = worker.workerId;
  if (!worker.paused || !isId(id) || !worker.sessionFile || !worker.sessionId || !worker.paneId ||
      state.inflight[id] || Object.values(state.notices).some(n => n.workerId === id &&
        ['pending', 'sending', 'uncertain'].includes(n.status))) return false;
  if (worker.delegationId && (await readJson(spawnPath(root, worker.delegationId))).status !== 'dispatched') return false;
  const possiblyLive = ({ agents }) => agents.some(a => a.pane_id === worker.paneId ||
    [worker.sessionFile, worker.sessionId].includes(a.agent_session?.value));
  if (possiblyLive(live)) return false;
  try { await transport(socketPath, 'pane.get', { pane_id: worker.paneId }); }
  catch (error) {
    if (error.code !== 'pane_not_found') throw error;
    return !possiblyLive(await readSnapshot(socketPath));
  }
  return false;
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
  const id = randomUUID();
  // Claims survive failures. Changing a key must not escape an identical task's claim.
  await claim(join(root, `spawn-key-${attemptKey}.json`), { id });
  await claim(join(root, `spawn-assignment-${assignmentKey}.json`), { id });
  const parentWorker = Object.values(authority.state.workers).find(w => w.sessionId === parent.sessionId &&
    w.paneId === parent.paneId);
  const recipient = parentWorker?.recipient ?? (parentWorker?.role === 'owner' ?
    { id: parentWorker.coordinatorId } : undefined);
  const spawn = { id, grantId: authority.grant.id, authority: reference, ownerToken: authority.grant.ownerToken,
    parent, role, key, task, status: 'prepared', at: new Date().toISOString(),
    ...(recipient ? { recipient, parentWorkerId: parentWorker.workerId } : {}) };
  await claim(spawnPath(root, id), spawn);
  const save = async status => { spawn.status = status; await atomicJson(spawnPath(root, id), spawn); };
  const launchFence = ownerLaunch ? ownerLaunchPath(root, authority.grant.checkout) : undefined;
  let fenceClaimed = false;
  let splitRequested = false;
  let dispatched = false;
  try {
    if (launchFence) {
      await claimOwnerLaunch(launchFence, id);
      fenceClaimed = true;
    }
    if (role === 'writer' || ownerLaunch) {
      // A conservative cooperating-writer fence. Never automatically release it
      // on model completion, a crash, rejection, or an uncertain creation.
      if (!authority.grant.checkout || await checkoutIdentity(authority.grant.cwd) !== authority.grant.checkout)
        refuse('Delegation checkout identity changed');
      const { state: current, fresh } = await check();
      for (const worker of Object.values(current.workers)) {
        let checkout;
        try { checkout = await checkoutIdentity(worker.cwd); }
        catch {
          // An unavailable cwd is not evidence that this worker is unrelated.
          refuse('Existing worker checkout cannot be verified; inspect writer ownership before delegation');
        }
        if (checkout === authority.grant.checkout) {
          const owner = worker.role === 'owner' && worker.coordinatorId &&
            worker.sessionId === parent.sessionId && worker.sessionFile === parent.sessionFile &&
            worker.paneId === parent.paneId && recipient?.id === worker.coordinatorId;
          if (!owner && !await closedWorker(root, socketPath, worker, current, fresh, transport, readSnapshot))
            refuse('Checkout already has a supervised worker; delegate read-only work or inspect writer ownership');
        }
      }
      if (ownerLaunch) {
        // Retained claims are not proof that it is safe to launch a successor.
        const writerClaim = join(root, `delegation-writer-${digest(authority.grant.checkout)}.json`);
        const writer = await readJson(writerClaim).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (writer) refuse('Checkout retains a writer claim; inspect ownership before launch');
      } else {
        await claim(join(root, `delegation-writer-${digest(authority.grant.checkout)}.json`), { id, grantId: spawn.grantId });
      }
    }
    await check();
    await save('creating');
    checkLocal();
    // From the first possible native effect until observed dispatch, retain the
    // checkout fence even if the response is lost or this process exits.
    splitRequested = true;
    const split = await transport(socketPath, 'pane.split', { target_pane_id: paneId, direction: 'right',
      cwd: authority.grant.cwd, focus: false,
      env: { PI_CONTINUATION_SPAWN: id, PI_CONTINUATION_ROOT: root } });
    if (split.type !== 'pane_info' || !split.pane?.pane_id || split.pane.pane_id === paneId ||
        live.agents.some(a => a.pane_id === split.pane.pane_id) || split.pane.workspace_id !== parent.workspaceId)
      refuse('Pane creation identity uncertain');
    spawn.paneId = split.pane.pane_id;
    spawn.terminalId = split.pane.terminal_id;
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
        target.pane.terminal_id !== spawn.terminalId || target.pane.workspace_id !== parent.workspaceId ||
        target.pane.tab_id !== parent.tabId || target.pane.agent || target.pane.agent_session)
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
    return { id, workerId: spawn.workerId, paneId: spawn.paneId, sessionId: spawn.child.sessionId,
      sessionFile: spawn.child.sessionFile, status: spawn.status };
  } catch (error) {
    spawn.failure = error.message;
    await save('held');
    throw new Error(`Delegation ${id} held for inspection (${error.message}). Do not retry under another key.`);
  } finally {
    if (fenceClaimed && (!splitRequested || dispatched)) {
      try { await release(launchFence, id); }
      catch { ctx.ui.notify(`Could not release owner launch fence ${id}; inspect before starting another`, 'warning'); }
    }
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
    let scope = argument.trim();
    if (ctx.mode !== 'tui' || process.env.HERDR_ENV !== '1' || !socketPath || !paneId || !ctx.isIdle() ||
        Buffer.byteLength(scope) > 8000)
      refuse('Use /start-implementation [agreed scope] in an idle Herdr Pi TUI (up to 8000 UTF-8 bytes)');
    const version = generation;
    const session = currentSession(ctx);
    const allowed = () => generation === version && ctx.isIdle() && !worker.hold && !worker.promptBlocked &&
      currentSession(ctx).leaf === session.leaf;
    const cwd = await realpath(ctx.cwd);
    const checkout = await checkoutIdentity(cwd);
    const state = await readSupervisor(root);
    const grant = { id: randomUUID(), cwd, checkout, role: 'writer', ownerLaunch: true,
      ownerToken: state.ownerToken, supervisorSession: state.supervisorSession, revoked: false };
    await delegationOwner(root, grant);
    const live = await snapshot(socketPath);
    grant.parent = nativeBinding(live.agents.find(a => a.pane_id === paneId), session, ctx.cwd);
    if (!allowed() || !sameSession(currentSession(ctx), grant.parent) || state.supervisorSession === session.id ||
        Object.values(state.workers).some(w => w.sessionId === session.id || w.sessionFile === session.file))
      refuse('Launch requires an unchanged unsupervised planning session');
    requireDelegationParent(live, grant.parent);
    if (state.routes[grant.parent.workspaceId]?.paused) refuse('Delegation route is paused');
    if (!scope) {
      const signal = AbortSignal.timeout(45000);
      try { scope = await agreedLaunchScope(ctx, signal); }
      catch { refuse('Could not read the agreed plan with the configured model. No owner launched.'); }
      if (!scope || signal.aborted)
        refuse('No single agreed assignment found. Clarify which plan to hand off, then run /start-implementation.');
      if (!allowed() || !sameSession(currentSession(ctx), grant.parent))
        refuse('Planning session changed while reading the plan; no owner launched');
    }
    grant.scope = scope;
    await claim(join(root, `owner-launch-${digest(`${checkout}\n${scope}`)}.json`), { grantId: grant.id });
    await claim(grantPath(root, grant.id), grant);
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
          const message = ticket.role === 'owner' ?
            `Approved assignment for this supervised coordinating owner (not the writer):\n${grant.scope}\n\n` +
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
