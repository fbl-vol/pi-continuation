import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { atomicJson, ensureRoot, defaultRoot, claim, readJson } from './store.mjs';
import { listenJson, ownerAlive, sendAction } from './ipc.mjs';
import { currentSession } from './session.mjs';
import { ownerDecisionEvidence, readSupervisor, readObservation } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';
import { snapshot, sameOccupant, isSettled } from './herdr.mjs';
import { pinnedCheckpoint, coordinatorCandidate } from './bindings.mjs';
import { checkpointHash } from './policy.mjs';

export function bindCoordinator(pi, { root = defaultRoot(), paneId = process.env.HERDR_PANE_ID,
  socketPath = process.env.HERDR_SOCKET_PATH, confirmOwner, decisionUI } = {}) {
  let close;
  let coordinator;
  let generation = 0;
  let humanPending = false;
  let uiPromptActive = false;
  let releaseInput = false;
  let selectionTurn = false;
  const report = diagnostics('coordinator');
  const listen = (record, ctx) => listenJson(root, record.id,
    notice => acceptNotice(record, ctx, notice), error => report('accept notice', error, ctx));

  pi.on('input', async event => {
    if (event.source === 'interactive' || event.source === 'rpc') {
      generation++;
      humanPending = true;
      if (coordinator?.role === 'owner') {
        try {
          const state = await readSupervisor(root);
          const owner = Object.entries(state.workers).find(([, w]) => w.role === 'owner' &&
            w.coordinatorId === coordinator.id && w.sessionId === coordinator.sessionId);
          releaseInput = state.ownerWaits[owner?.[0]]?.kind === 'released';
        } catch (error) { releaseInput = false; report('inspect owner release', error); }
      }
    } else {
      // sendUserMessage emits extension input before messageType=user; a handled
      // or failed earlier user preflight cannot authorize that synthetic run.
      releaseInput = false;
    }
  });
  pi.on('before_agent_start', event => {
    // Pi skips input for extension commands. A confirmed release alone is not a user turn.
    selectionTurn = event.messageType === 'user' && releaseInput;
    releaseInput = false;
  });
  pi.on('agent_start', () => { generation++; });
  pi.on('agent_settled', async (event, ctx) => {
    humanPending = false;
    if (selectionTurn && !event.aborted) {
      selectionTurn = false;
      try { await ownerRequest(ctx, 'settled-user'); }
      catch (error) { report('settle owner release', error, ctx); }
    } else selectionTurn = false;
  });
  pi.on('ui_prompt_start', () => { uiPromptActive = true; });
  pi.on('ui_prompt_end', () => { uiPromptActive = false; });
  pi.on('session_start', async (_event, ctx) => {
    coordinator = undefined;
    if (ctx.mode !== 'tui' || process.env.HERDR_ENV !== '1' || !paneId) return;
    const entry = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
      e.customType === 'pi-continuation-coordinator').at(-1)?.data;
    if (!entry || entry.sessionId !== currentSession(ctx).id || entry.paneId !== paneId) return;
    try {
      const record = await readJson(join(root, `coordinator-${entry.id}.json`));
      if (record.sessionId !== entry.sessionId || record.sessionFile !== currentSession(ctx).file) return;
      close = await listen(record, ctx);
      coordinator = record;
    } catch (error) { report('restore registration', error, ctx); }
  });

  async function completionCurrent(state, notice) {
    if (notice.kind !== 'completion') return true;
    const worker = state.workers?.[notice.workerId];
    if (!worker) return false;
    const live = await snapshot(socketPath);
    const agent = live.agents.find(a => a.pane_id === worker.paneId);
    if (!sameOccupant(agent, worker) || !isSettled(agent)) return false;
    const observation = await readObservation(root, notice.workerId);
    if (observation.stop !== notice.stop || observation.outcome !== 'completed' || observation.hold ||
        observation.session?.id !== worker.sessionId || observation.session?.file !== worker.sessionFile ||
        !notice.reportHash) return false;
    try {
      return checkpointHash(await readFile(await pinnedCheckpoint(root, notice.workerId, worker), 'utf8')) ===
        notice.reportHash;
    } catch { return false; }
  }

  async function acceptNotice(record, ctx, notice) {
    const state = await readSupervisor(root);
    const owner = await readJson(join(root, 'supervisor.lock'));
    const route = state.routes?.[notice.route];
    const now = currentSession(ctx);
    const version = generation;
    try { await coordinatorCandidate(root, record.id, state, await snapshot(socketPath)); }
    catch { return { accepted: false }; }
    if (!await ownerAlive(root, owner.token) ||
        state.paused || route?.paused || (notice.recipient ?
          state.workers[notice.workerId]?.recipient?.id !== record.id : route?.coordinator?.id !== record.id) ||
        notice.ownerToken !== owner.token || owner.token !== state.ownerToken ||
        now.id !== record.sessionId || now.file !== record.sessionFile ||
        notice.id !== state.notices?.[notice.id]?.id || state.notices[notice.id].status !== 'sending') {
      return { accepted: false };
    }
    const recipientWorker = Object.values(state.workers).find(w => w.role === 'owner' &&
      w.sessionId === record.sessionId && w.coordinatorId === record.id);
    const waiting = recipientWorker && state.ownerWaits?.[recipientWorker.workerId];
    if ((recipientWorker && (recipientWorker.paused || recipientWorker.stopped ||
        state.routes[recipientWorker.route]?.paused ||
        (await readObservation(root, recipientWorker.workerId)).hold)) ||
        ['user', 'released'].includes(waiting?.kind) || (waiting?.kind === 'child' &&
        !waiting.children.includes(notice.workerId))) {
      return { accepted: false, deferred: true, id: notice.id };
    }
    if (humanPending || uiPromptActive || !ctx.isIdle()) {
      // No receipt claimed or effect attempted: retryable, unlike post-acceptance rejection.
      return { accepted: false, deferred: true, id: notice.id };
    }
    if (!await completionCurrent(state, notice)) return { accepted: false, stale: true, id: notice.id };

    await claim(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'accepted' });
    const completionStillCurrent = await completionCurrent(state, notice);
    const latest = await readSupervisor(root);
    try { await coordinatorCandidate(root, record.id, latest, await snapshot(socketPath)); }
    catch { return { accepted: false }; }
    const latestWorker = Object.values(latest.workers).find(w => w.role === 'owner' &&
      w.sessionId === record.sessionId && w.coordinatorId === record.id);
    const latestWait = latestWorker && latest.ownerWaits?.[latestWorker.workerId];
    if (!completionStillCurrent || latest.paused || latest.ownerToken !== owner.token || latest.routes?.[notice.route]?.paused ||
        (notice.recipient ? latest.workers[notice.workerId]?.recipient?.id !== record.id :
          latest.routes?.[notice.route]?.coordinator?.id !== record.id) ||
        (latestWorker && (latestWorker.paused || latestWorker.stopped ||
          latest.routes[latestWorker.route]?.paused ||
          (await readObservation(root, latestWorker.workerId)).hold)) ||
        ['user', 'released'].includes(latestWait?.kind) || (latestWait?.kind === 'child' &&
          !latestWait.children.includes(notice.workerId)) ||
        humanPending || uiPromptActive || !ctx.isIdle() || generation !== version || currentSession(ctx).leaf !== now.leaf) {
      return { accepted: false };
    }
    pi.sendMessage({ customType: 'pi-continuation-notice', display: true,
      content: `Material ${notice.kind} notice for registered worker ${notice.workerId}: ${notice.text}. This is information, not approval authority.` },
    { triggerTurn: true });
    await atomicJson(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'sent' });
    return { accepted: true, id: notice.id };
  }

  async function register(ctx, id, owner) {
    if (coordinator) throw new Error('Coordinator already registered');
    await ensureRoot(root);
    const session = currentSession(ctx);
    const record = { id, sessionId: session.id, sessionFile: session.file,
      cwd: ctx.cwd, paneId, ...(owner ? { role: 'owner' } : {}) };
    await claim(join(root, `coordinator-${id}.json`), record);
    pi.appendEntry('pi-continuation-coordinator', { id, sessionId: session.id, paneId,
      ...(owner ? { role: 'owner' } : {}) });
    close = await listen(record, ctx);
    coordinator = record;
    return record;
  }

  pi.registerCommand('continuation-coordinator', {
    description: 'Register this exact Pi session as a material-notice recipient; does not grant approval',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui' || !paneId || process.env.HERDR_ENV !== '1')
        throw new Error('Requires a Herdr-managed Pi TUI');
      if (coordinator) { ctx.ui.notify(`Coordinator already registered: ${coordinator.id}`); return; }
      const owner = args.trim() === 'owner';
      if (args.trim() && !owner) throw new Error('Usage: /continuation-coordinator [owner]');
      const before = currentSession(ctx);
      if (owner) {
        const state = await readSupervisor(root);
        if (!state.acceptStarts || !await ownerAlive(root, state.ownerToken) ||
            Object.values(state.workers).some(w => w.sessionId === before.id || w.paneId === paneId))
          throw new Error('Start the intended global supervisor first; register owner before worker enrollment');
        const live = (await snapshot(socketPath)).agents.find(a => a.pane_id === paneId);
        if (live?.agent !== 'pi' || live.agent_session?.source !== 'herdr:pi' ||
            live.agent_session.kind !== 'path' || live.agent_session.value !== before.file ||
            (live.foreground_cwd || live.cwd) !== ctx.cwd)
          throw new Error('Owner requires an exact saved Herdr Pi session');
      }
      if (!await ctx.ui.confirm(owner ? 'Register non-writing owner?' : 'Register coordinator?',
        owner ? 'Receive only exact child material notices. To supervise this coordinating session, run /continuation-worker start afterward. This is not a writer or global supervisor.' :
          'Receive material notices in this exact session; no continuation or approval authority.')) return;
      try {
        const session = currentSession(ctx);
        if (owner && (session.id !== before.id || session.file !== before.file ||
            session.leaf !== before.leaf || !ctx.isIdle()))
          throw new Error('Owner session changed during confirmation');
        const record = await register(ctx, randomUUID(), owner);
        ctx.ui.notify(`Coordinator ${record.id} registered`);
      } catch (error) { throw report('register', error); }
    },
  });
  const ownerRequest = async (ctx, kind, children, decision) => {
    if (!coordinator || coordinator.role !== 'owner')
      throw new Error('Exact registered coordinating owner required');
    const state = await readSupervisor(root);
    const worker = Object.values(state.workers).find(w => w.role === 'owner' &&
      w.coordinatorId === coordinator.id && w.sessionId === currentSession(ctx).id &&
      w.sessionFile === currentSession(ctx).file && w.paneId === paneId);
    if (!worker) throw new Error('Start supervision for this owner before setting its wait state');
    const result = await sendAction(root, { type: 'owner-wait', kind, children, decision,
      workerId: worker.workerId, coordinatorId: coordinator.id,
      sessionId: worker.sessionId, sessionFile: worker.sessionFile }, 'supervisor', decision ? { timeoutMs: 15000 } : undefined);
    if (!result.accepted) throw new Error(result.message ?? 'Owner wait rejected; inspect exact supervision and decision state');
    return result;
  };
  pi.registerTool({
    name: 'continuation_owner_wait', label: 'Wait as coordinating owner',
    description: 'Record an owner wait for named children or a real user decision. Child notices wake only a child wait. For decisions, direct the user to /continuation-owner decide; this tool cannot release a decision.',
    parameters: Type.Object({ kind: Type.Union([Type.Literal('child'), Type.Literal('user')]),
      children: Type.Optional(Type.Array(Type.String())) }),
    async execute(_call, args, _signal, _update, ctx) {
      await ownerRequest(ctx, args.kind, args.children);
      return { content: [{ type: 'text', text: `Owner waiting for ${args.kind}; no automatic user decision is inferred.` }], details: {} };
    },
  });
  const releaseDecision = async ctx => {
    if (coordinator?.role !== 'owner' || !ctx.isIdle())
      throw new Error('Release the user decision in the idle exact owner session');
    if (!confirmOwner) throw new Error('Owner release requires the worker-owned guarded confirmation');
    if (!await confirmOwner(ctx, 'Release user-decision wait?',
      'Confirm the user has actually provided the decision or selected findings in this owner pane. This command grants no approval, applies no fixes and does not release worker holds.')) return;
    await ownerRequest(ctx, 'resume-user');
    ctx.ui.notify('User-decision wait awaits an ordinary user turn; send the selected instruction as user input', 'info');
  };
  const submitDecision = async ctx => {
    if (ctx.mode !== 'tui' || !decisionUI || coordinator?.role !== 'owner' || !ctx.isIdle())
      throw new Error('Submit in the idle exact coordinating owner pane');
    const session = currentSession(ctx);
    await decisionUI.flushObservations();
    const state = await readSupervisor(root);
    const owner = Object.values(state.workers).find(w => w.role === 'owner' && w.coordinatorId === coordinator?.id &&
      w.paneId === paneId && w.sessionId === session.id && w.sessionFile === session.file);
    const wait = state.ownerWaits[owner?.workerId];
    if (wait?.kind !== 'user' || !wait.id || wait.decisionId)
      throw new Error('No fresh pending decision; inspect any earlier submission, or use explicit recovery for legacy waits');
    if (state.paused || owner.paused || state.routes[owner.route]?.paused)
      throw new Error('Owner supervision is paused');
    const observed = await readObservation(root, owner.workerId);
    const evidence = ownerDecisionEvidence(observed, owner);
    if (!evidence || evidence.leaf !== session.leaf || evidence.version !== decisionUI.interactionVersion ||
        (decisionUI.hold && !decisionUI.launchEvidence(ctx))) throw new Error('Owner decision stop is stale or held');
    const answer = await decisionUI.inputDecision(ctx,
      'Submit decision to the existing writer\nEnter the exact decision and scope, not a question. Escape cancels.');
    if (answer === undefined) return;
    if (!answer.trim() || Buffer.byteLength(JSON.stringify(answer)) > 4000)
      throw new Error('Enter a nonempty decision of at most 4000 encoded bytes');
    const stillCurrent = () => ctx.isIdle() && !decisionUI.promptBlocked && evidence.version === decisionUI.interactionVersion &&
      isDeepStrictEqual(currentSession(ctx), session);
    if (!stillCurrent()) throw new Error('Owner decision changed during input');
    const id = randomUUID();
    await claim(join(root, `decision-input-${id}.json`), { id, workerId: owner.workerId, coordinatorId: owner.coordinatorId,
      sessionId: owner.sessionId, sessionFile: owner.sessionFile, waitId: wait.id, ownerToken: state.ownerToken, evidence, answer });
    if (!stillCurrent()) throw new Error('Owner decision changed after capture; no delivery requested');
    await ownerRequest(ctx, 'submit-decision', undefined, id);
    await decisionUI.finishDecisionCommand(ctx, evidence);
    ctx.ui.notify('Decision delivered to the existing writer; exact owner wait released.', 'info');
  };
  pi.registerCommand('continuation-owner', {
    description: 'Submit the pending decision (decide) or explicitly release a legacy wait (resume)',
    handler: (args, ctx) => {
      if (args.trim() === 'decide') return submitDecision(ctx);
      if (args.trim() !== 'resume') throw new Error('Usage: /continuation-owner decide | resume');
      return releaseDecision(ctx);
    },
  });
  pi.on('session_shutdown', async () => {
    generation++; coordinator = undefined; releaseInput = false; selectionTurn = false;
    await close?.(); close = undefined;
  });
  return { registerOwner: (ctx, id) => register(ctx, id, true), releaseDecision, submitDecision };
}
