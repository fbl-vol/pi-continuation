import { randomUUID } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, atomicText, defaultRoot, ensureRoot, readJson } from './store.mjs';
import { ownerAlive, sendAction } from './ipc.mjs';
import { managedCheckpointPath, managedCheckpointText } from './checkpoint.mjs';
import { receive } from './receiver.mjs';
import { currentSession } from './session.mjs';
import { readyWorkerRegistration } from './bindings.mjs';
import { commitReady } from './registration.mjs';
import { SCHEMA_VERSION, MAX_FINAL_REPLY_BYTES, readObservation, readSupervisor, isId } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';
import { guardPromptUI } from './prompt-guard.mjs';

const replyText = entry => Array.isArray(entry?.message?.content) ? entry.message.content
  .filter(part => part?.type === 'text' && typeof part.text === 'string')
  .map(part => part.text).join('\n').trim() : '';

export function stopObservation(ctx, aborted, hold, version, previousAssistantId) {
  const session = currentSession(ctx);
  const last = [...ctx.sessionManager.getBranch()].reverse().find(e =>
    e.type === 'message' && e.message?.role === 'assistant');
  const fresh = last && last.id !== previousAssistantId;
  const reply = fresh ? replyText(last) : '';
  const replyAvailable = reply.length > 0 && Buffer.byteLength(reply, 'utf8') <= MAX_FINAL_REPLY_BYTES;
  const completed = fresh && last.message?.stopReason === 'stop';
  const outcome = aborted ? 'aborted' : fresh && last.message?.stopReason === 'error' ? 'error' :
    hold || (completed && !replyAvailable) ? 'approval' : completed ? 'completed' : 'unknown';
  return { session, outcome, stop: randomUUID(), version, at: new Date().toISOString(),
    ...(replyAvailable ? { finalReply: reply } : {}) };
}

const latestConversation = ctx => [...ctx.sessionManager.getBranch()].reverse().find(entry =>
  (entry.type === 'message' && entry.message?.role !== 'system') ||
  ['custom_message', 'compaction', 'branch_summary', 'context_edit'].includes(entry.type));

// Recover only a fresh, unchanged successful reply. Managed input fences can
// park the same native stop for explicit start; never mint a replacement nonce.
// Delivered/handled effects remain guarded by the supervisor's retained history.
function currentHeldReport(prior, ctx, version, session) {
  if (prior.schemaVersion !== SCHEMA_VERSION || prior.outcome !== 'approval' || !prior.hold ||
      !isId(prior.stop) || prior.version !== version || !prior.finalReply?.trim() ||
      !session.id || !session.file || !session.leaf ||
      prior.session.id !== session.id || prior.session.file !== session.file ||
      prior.session.leaf !== session.leaf) return null;
  const tail = latestConversation(ctx);
  if (tail?.type !== 'message' || tail.message?.role !== 'assistant' ||
      tail.message.stopReason !== 'stop' || replyText(tail) !== prior.finalReply) return null;
  return { ...prior, outcome: 'completed' };
}

export function bindObservation(pi, { root = defaultRoot(), socketPath = process.env.HERDR_SOCKET_PATH,
  paneId = process.env.HERDR_PANE_ID, launchGuard = () => false, promptScope,
  reviewCurrentReports = false, isInterrupt = data => data === '\u001b' } = {}) {
  let worker;
  let preparing;
  let starting = false;
  let initialPending;
  const report = diagnostics('worker');
  let hold = false;
  let holdReason;
  let parkedReport;
  let lastObserved;
  let stopVersion = 0;
  let previousAssistantId;
  const lastAssistantId = ctx => [...ctx.sessionManager.getBranch()].reverse().find(e =>
    e.type === 'message' && e.message?.role === 'assistant')?.id;
  let closeReceiver;
  let stopTerminalInput;
  let prompts;
  let promptUI;
  let pendingWrite = Promise.resolve();
  const connectReceiver = (ctx, record) => receive(root, record, pi, ctx,
    () => stopVersion, () => hold || worker !== record || !prompts || prompts.blocked);
  const startReceiver = async ctx => {
    if (worker) closeReceiver = await connectReceiver(ctx, worker);
  };
  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive' && event.source !== 'rpc') return;
    stopVersion++;
    if (preparing) preparing.interrupted = true;
    if (!worker) return;
    // Submitted task text relinquishes only a provisional typing fence. Native
    // prompts, Escape, aborts and errors remain sticky until explicit start.
    if (worker.managedInput && holdReason === 'typing') {
      hold = false;
      holdReason = undefined;
    }
    parkedReport = undefined;
    return observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
  });
  const observe = (value, ctx) => {
    const owner = worker;
    // Hold is independent of activity: a new turn must not erase an unresolved stop.
    const saved = { ...value, schemaVersion: SCHEMA_VERSION, hold, version: stopVersion,
      holdReason: owner.managedInput && hold ? holdReason ?? 'restored' : undefined,
      parkedReport: owner.managedInput ? parkedReport : undefined,
      ...(promptScope ? { promptScope: promptScope.snapshot() } : {}) };
    let checkpoint;
    let checkpointError;
    try { if (owner.managedCheckpoint) checkpoint = managedCheckpointText(ctx); }
    catch (error) { checkpointError = error; }
    lastObserved = saved;
    pendingWrite = pendingWrite.then(async () => {
      try {
        if (checkpointError) throw checkpointError;
        if (checkpoint !== undefined) await atomicText(owner.checkpoint, checkpoint);
      } catch (error) {
        hold = true;
        holdReason = 'error';
        await atomicJson(`${root}/observation-${owner.workerId}.json`, {
          ...saved, outcome: 'error', stop: null, hold: true, holdReason: 'error', parkedReport: undefined });
        throw error;
      }
      await atomicJson(`${root}/observation-${owner.workerId}.json`, saved);
    })
      .then(() => true)
      .catch(error => {
        if (worker === owner) worker = undefined;
        report('persist observation', error, ctx);
        return false;
      });
    return pendingWrite;
  };
  const captureExisting = async ctx => {
    if (!ctx.isIdle()) {
      previousAssistantId = lastAssistantId(ctx);
      return true;
    }
    // Ignore metadata, not later conversation/context boundaries. An older
    // successful assistant must not substitute for an unfinished/aborted turn.
    const tail = latestConversation(ctx);
    if (!tail) return true;
    // Capture after append/ready so its leaf is current. No scope is activated.
    const existing = tail.type === 'message' && tail.message.role === 'assistant' ?
      stopObservation(ctx, false, hold, stopVersion) : null;
    if (!existing || existing.outcome === 'unknown') {
      hold = true;
      return observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
    }
    hold ||= existing.outcome !== 'completed';
    return observe(existing, ctx);
  };
  const watchTerminalInput = ctx => {
    // Fence immediately, even before Pi knows whether typing will submit a task
    // or open a native menu. Only a confirmed start may recover a parked report.
    stopTerminalInput = ctx.ui.onTerminalInput(data => {
      if (preparing) { preparing.interrupted = true; stopVersion++; return; }
      if (!worker || (hold && (!worker.managedInput || !isInterrupt(data)))) return;
      if (worker.managedInput && !hold) parkedReport = lastObserved?.stop ? lastObserved : undefined;
      hold = true;
      holdReason = isInterrupt(data) ? 'interruption' : 'typing';
      stopVersion++;
      if (parkedReport) parkedReport = { ...parkedReport, outcome: 'approval', hold: true,
        parkedReport: undefined, version: stopVersion };
      void observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
    });
  };
  const externalPrompt = ctx => {
    if (preparing) { preparing.interrupted = true; stopVersion++; return; }
    if (!worker) return;
    hold = true;
    holdReason = 'prompt';
    parkedReport = undefined;
    stopVersion++;
    void observe({ session: currentSession(ctx), outcome: 'approval', stop: null }, ctx);
  };
  const promptsFor = ctx => {
    if (!prompts) {
      promptUI = ctx.ui;
      prompts = guardPromptUI(promptUI, () => externalPrompt(ctx), promptScope);
    }
    if (ctx.ui !== promptUI || !prompts.intact) throw new Error('Worker prompt guard unavailable');
    return prompts;
  };
  pi.on('ui_prompt_start', (_event, ctx) => {
    if (prompts) prompts.start();
    else externalPrompt(ctx);
  });
  pi.on('ui_prompt_end', () => prompts?.end());
  pi.on('tool_execution_end', (event, ctx) => {
    if (event.isError && preparing) { preparing.interrupted = true; stopVersion++; }
    if (!event.isError || !worker) return;
    hold = true;
    holdReason = 'error';
    parkedReport = undefined;
    stopVersion++;
    return observe({ session: currentSession(ctx), outcome: 'error', stop: null }, ctx);
  });

  pi.on('session_start', async (_event, ctx) => {
    if (preparing) preparing.interrupted = true;
    if (initialPending) { clearTimeout(initialPending.timer); initialPending = undefined; }
    stopTerminalInput?.();
    stopTerminalInput = undefined;
    worker = undefined;
    holdReason = undefined; parkedReport = undefined; lastObserved = undefined;
    prompts?.dispose(); prompts = undefined; promptUI = undefined;
    if (ctx.mode !== 'tui' || !socketPath || !paneId || process.env.HERDR_ENV !== '1') return;
    try { promptsFor(ctx); }
    catch (error) { report('guard prompts', error, ctx); return; }
    const restoreRevision = prompts.revision;
    // A fork/new session has a different ID. A copied session entry never binds it.
    const session = currentSession(ctx);
    const entries = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
      e.customType === 'pi-continuation-worker');
    const binding = entries.at(-1)?.data;
    if (!binding || binding.sessionId !== session.id || binding.paneId !== paneId) return;
    if (!await launchGuard()) {
      ctx.ui.notify('Continuation worker disabled: start Pi with -e <extension file> as its first option', 'error');
      return;
    }
    try {
      await ensureRoot(root);
      const record = await readJson(`${root}/worker-${binding.workerId}.json`);
      await readyWorkerRegistration(root, record);
      if (record.sessionId === session.id && record.paneId === paneId && record.sessionFile === session.file) {
        worker = record;
        let promptInterrupted = false;
        try {
          const prior = await readObservation(root, worker.workerId);
          const scope = promptScope?.snapshot();
          const scopeChanged = prior.promptScope?.id !== scope?.id ||
            prior.promptScope?.revision !== scope?.revision;
          promptInterrupted = prompts.blocked || prompts.revision !== restoreRevision || !!scopeChanged;
          hold = prior.hold || prior.bootstrapPending === true || promptInterrupted;
          holdReason = hold ? promptInterrupted ? 'prompt' : prior.holdReason ?? 'restored' : undefined;
          parkedReport = promptInterrupted ? undefined : prior.parkedReport;
          lastObserved = prior;
          if (Number.isSafeInteger(prior.version) && prior.version >= 0)
            stopVersion = Math.max(stopVersion, prior.version);
        } catch (error) { hold = true; report('restore observation', error, ctx); }
        if (promptInterrupted) {
          // Before worker assignment the guard has no observation to update.
          // Invalidate the old eligible stop durably before exposing a receiver.
          stopVersion++;
          await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
          if (!worker) return;
        }
        if (!ctx.isIdle()) previousAssistantId = lastAssistantId(ctx);
        watchTerminalInput(ctx);
        await startReceiver(ctx);
      }
    } catch (error) {
      worker = undefined;
      stopTerminalInput?.();
      stopTerminalInput = undefined;
      report('restore registration', error, ctx);
    }
  });

  pi.registerCommand('continuation-worker', {
    description: 'Start or return to supervision: start | advanced registration: <checkpoint> or --start {"checkpoint":"/path","message":"task"}',
    handler: async (argument, ctx) => {
      if (argument.trim() !== 'start') return registerWorker(argument, ctx);
      if (starting) { ctx.ui.notify('Worker start is already in progress', 'info'); return; }
      starting = true;
      try { return await startWorker(ctx); }
      finally { starting = false; }
    },
  });

  const registerWorker = async (argument, ctx, managed = false) => {
      if (ctx.mode !== 'tui' || !socketPath || !paneId || process.env.HERDR_ENV !== '1') {
        ctx.ui.notify('Requires a Herdr-managed Pi TUI with its integration', 'error'); return;
      }
      let guard;
      try { guard = promptsFor(ctx); }
      catch (error) { report('guard prompts', error, ctx); return; }
      const registrationRevision = guard.revision;
      const registrationVersion = stopVersion;
      if (!await launchGuard()) {
        ctx.ui.notify('Start Pi with -e <extension file> as its first option before registering', 'error');
        return;
      }
      if (worker || preparing) { ctx.ui.notify('Registration already active in this session', 'info'); return; }
      const input = argument.trim();
      let checkpointPath = input;
      let initialMessage = '';
      if (input.startsWith('--start ')) {
        let ambiguousPath = false;
        try { await access(resolve(ctx.cwd, input)); ambiguousPath = true; } catch { /* Not a pathname. */ }
        if (ambiguousPath) {
          ctx.ui.notify('Ambiguous checkpoint path; use an absolute path for registration', 'warning'); return;
        }
        let request;
        try { request = JSON.parse(input.slice('--start '.length)); } catch { /* Invalid request below. */ }
        if (!request || typeof request.checkpoint !== 'string' ||
            typeof request.message !== 'string' || !request.checkpoint.trim() || !request.message.trim() ||
            !ctx.isIdle()) {
          ctx.ui.notify('Usage: /continuation-worker --start {"checkpoint":"/path","message":"task"} (idle only)', 'warning');
          return;
        }
        checkpointPath = request.checkpoint;
        initialMessage = request.message;
      }
      const workerId = randomUUID();
      const checkpoint = managed ? managedCheckpointPath(root, workerId) : resolve(ctx.cwd, checkpointPath);
      if (!managed) try { await access(checkpoint); } catch {
        ctx.ui.notify('Existing checkpoint path required', 'error'); return;
      }
      const session = currentSession(ctx);
      if (guard.blocked || guard.revision !== registrationRevision || stopVersion !== registrationVersion) {
        ctx.ui.notify('Registration interrupted by another interaction; inspect before retrying.', 'warning'); return;
      }
      if (!await guard.confirm(managed ? 'Start worker supervision?' : 'Register continuation worker?', managed ?
        'Join the running supervisor and enable this exact session. Ordinary task messages remain supervised; Escape, prompts and errors stop it. Confirm no other continuation owner supervises this worker.' :
        `Bind this session and checkpoint for observation?\n${checkpoint}${initialMessage ?
          '\nStart the explicitly supplied initial user message after registration?' : ''}`)) return;
      if (stopVersion !== registrationVersion || guard.revision !== registrationRevision) {
        ctx.ui.notify('Registration interrupted during confirmation; no message sent.', 'warning'); return;
      }
      const record = { workerId, sessionId: session.id, sessionFile: session.file,
        paneId, checkpoint, cwd: ctx.cwd, socketPath, stateRoot: root, paused: true, requiresReady: true,
        ...(managed ? { managedInput: true, managedCheckpoint: true } : {}) };
      const candidate = { interrupted: false, version: stopVersion };
      preparing = candidate;
      let receiver;
      let workerSaved = false;
      let observationSaved = false;
      let published = false;
      try {
        watchTerminalInput(ctx);
        await ensureRoot(root);
        if (managed) await atomicText(checkpoint, managedCheckpointText(ctx));
        await atomicJson(`${root}/worker-${record.workerId}.json`, record);
        workerSaved = true;
        await atomicJson(`${root}/observation-${record.workerId}.json`, {
          session, outcome: 'unknown', stop: null, schemaVersion: SCHEMA_VERSION,
          // The first turn remains held until Pi confirms it started. A plain
          // registration has no resumable stop, and its marker gates restore.
          hold: !!initialMessage, version: stopVersion,
          ...(promptScope ? { promptScope: promptScope.snapshot() } : {}),
          ...(initialMessage ? { bootstrapPending: true } : {}),
        });
        observationSaved = true;
        // The provisional receiver rejects requests until this exact worker is published.
        receiver = await connectReceiver(ctx, record);
        const ready = (checkLeaf = true) => {
          const now = currentSession(ctx);
          return !candidate.interrupted && candidate.version === stopVersion && !hold && !guard.blocked &&
            guard.revision === registrationRevision &&
            now.id === session.id && now.file === session.file && (!checkLeaf || now.leaf === session.leaf) &&
            (!initialMessage || ctx.isIdle());
        };
        if (!ready()) {
          ctx.ui.notify('Registration interrupted before its first turn; no message sent. Inspect and retry once idle.', 'warning');
          return;
        }
        pi.appendEntry('pi-continuation-worker', { workerId: record.workerId,
          sessionId: record.sessionId, paneId });
        // appendEntry is synchronous but may invoke other extensions. Its effects
        // cannot confer permission if an approval hold started in the meantime.
        if (!ready(false)) {
          ctx.ui.notify('Registration interrupted before its first turn; no message sent. Inspect and retry once idle.', 'warning');
          return;
        }
        // A cancelled provisional registration may leave a session entry if
        // cleanup fails. Only this synchronous commit makes it restorable.
        commitReady(`${root}/ready-${record.workerId}.json`, record);
        worker = record;
        closeReceiver = receiver;
        receiver = undefined;
        preparing = undefined;
        published = true;
        // No await between the final live check and native user-message dispatch.
        // Pi's sendUserMessage is void: only an observed matching run establishes
        // that the first turn actually started. Never resend an uncertain message.
        if (initialMessage) {
          const pending = { worker: record, message: initialMessage, version: stopVersion, matched: false };
          initialPending = pending;
          pending.timer = setTimeout(() => {
            if (initialPending !== pending || worker !== record) return;
            initialPending = undefined;
            hold = true;
            stopVersion++;
            void observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
            ctx.ui.notify('Initial user turn was not observed; worker held. Inspect before retrying.', 'warning');
          }, 30000);
          pending.timer.unref?.();
          pi.sendUserMessage(initialMessage);
          ctx.ui.notify(`Worker ${record.workerId} registered paused; awaiting initial user turn`, 'info');
        } else {
          if (reviewCurrentReports && !await captureExisting(ctx)) return;
          ctx.ui.notify(managed ? 'Worker registered; joining the supervisor' :
            `Worker ${record.workerId} registered paused; no continuation is active`, 'info');
        }
      } catch (error) {
        if (published) {
          if (initialPending) { clearTimeout(initialPending.timer); initialPending = undefined; }
          hold = true;
          stopVersion++;
          await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
        }
        report('register worker', error, ctx);
      } finally {
        if (!published) {
          if (preparing === candidate) preparing = undefined;
          stopTerminalInput?.();
          stopTerminalInput = undefined;
          const discard = [receiver && (async () => {
            try { await receiver(); } catch (error) { closeReceiver = receiver; throw error; }
          }),
            observationSaved && (() => rm(`${root}/observation-${record.workerId}.json`)),
            workerSaved && (() => rm(`${root}/worker-${record.workerId}.json`)),
            managed && (() => rm(checkpoint, { force: true }))];
          for (const effect of discard) {
            if (!effect) continue;
            try { await effect(); } catch (error) { report('discard provisional registration', error, ctx); }
          }
        }
      }
  };

  const startWorker = async ctx => {
    if (ctx.mode !== 'tui' || !socketPath || !paneId || process.env.HERDR_ENV !== '1') {
      ctx.ui.notify('Requires a Herdr-managed Pi TUI with its integration', 'error'); return;
    }
    if (preparing) { ctx.ui.notify('Worker registration is still in progress', 'warning'); return; }
    let supervisor;
    try {
      supervisor = await readSupervisor(root);
      if (!supervisor.acceptStarts || !await ownerAlive(root, supervisor.ownerToken)) {
        ctx.ui.notify('Run /continuation-supervisor start in the intended supervisor first', 'warning'); return;
      }
    } catch (error) {
      if (error.code === 'ENOENT') ctx.ui.notify('Run /continuation-supervisor start first', 'warning');
      else report('find supervisor', error, ctx);
      return;
    }
    const session = currentSession(ctx);
    const entries = ctx.sessionManager.getBranch();
    if (session.id === supervisor.supervisorSession || entries.some(entry =>
      entry.type === 'custom' && entry.customType === 'pi-continuation-coordinator' &&
      entry.data?.sessionId === session.id)) {
      ctx.ui.notify('A supervisor or coordinator cannot become a worker', 'error'); return;
    }
    if (!worker) {
      // Do not create a new registration to escape a disabled committed binding.
      for (const entry of entries.filter(entry => entry.type === 'custom' &&
        entry.customType === 'pi-continuation-worker' && entry.data?.sessionId === session.id)) {
        if (entry.data.stateRoot !== root || !isId(entry.data.workerId)) {
          ctx.ui.notify('This session has another or unknown registration owner; inspect before start', 'warning'); return;
        }
        try {
          await access(`${root}/ready-${entry.data.workerId}.json`);
          ctx.ui.notify('This session has an inactive registration; inspect and reload before start', 'warning'); return;
        } catch (error) { if (error.code !== 'ENOENT') { report('inspect registration', error, ctx); return; } }
      }
      await registerWorker('', ctx, true);
      if (!worker) return;
    } else {
      const guard = promptsFor(ctx);
      const version = stopVersion;
      if (guard.blocked || (!ctx.isIdle() && hold && holdReason !== 'typing')) {
        ctx.ui.notify('Resolve the current interruption or prompt and wait until idle before start', 'warning'); return;
      }
      if (!await guard.confirm('Return worker to supervision?',
        'Clear the resolved hold and enable this exact worker. Unanswered decisions are not approved; other scope pauses and delivery history remain unchanged.')) return;
      const now = currentSession(ctx);
      if (version !== stopVersion || now.id !== session.id || now.file !== session.file ||
          now.leaf !== session.leaf || guard.blocked) {
        ctx.ui.notify('Worker changed during confirmation; start not accepted', 'warning'); return;
      }
      await pendingWrite;
      const prior = await readObservation(root, worker.workerId);
      const fresh = currentSession(ctx);
      if (worker?.sessionId !== session.id || version !== stopVersion ||
          fresh.id !== now.id || fresh.file !== now.file || fresh.leaf !== now.leaf || guard.blocked) {
        ctx.ui.notify('Worker changed while inspecting the held report; start not accepted', 'warning'); return;
      }
      const currentReport = ctx.isIdle() ? currentHeldReport(prior, ctx, version, now) ??
        (worker.managedInput && prior.parkedReport ? currentHeldReport(prior.parkedReport, ctx, version, now) : null) : null;
      const unchanged = !prior.hold && prior.version === version &&
        prior.session.id === now.id && prior.session.file === now.file && prior.session.leaf === now.leaf;
      worker.managedInput = true;
      hold = false; holdReason = undefined; parkedReport = undefined;
      stopVersion++;
      if (!await observe(currentReport ?? (unchanged ? prior :
        { session: now, outcome: ctx.isIdle() ? 'unknown' : 'working', stop: null }), ctx)) return;
    }
    const record = worker;
    if (!record) return;
    record.stateRoot = root;
    record.start = { nonce: randomUUID(), ownerToken: supervisor.ownerToken };
    try {
      await atomicJson(`${root}/worker-${record.workerId}.json`, record);
      const result = await sendAction(root, { type: 'worker-start', workerId: record.workerId,
        nonce: record.start.nonce, ownerToken: supervisor.ownerToken }, 'supervisor');
      if (!result.accepted || result.workerId !== record.workerId || result.nonce !== record.start.nonce ||
          result.ownerToken !== supervisor.ownerToken) {
        hold = true; holdReason = 'restored'; stopVersion++;
        await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
        ctx.ui.notify('Worker start not accepted; inspect supervisor status before retrying', 'warning'); return;
      }
      ctx.ui.notify(result.globalPaused || result.routePaused || result.workerPaused ?
        'Worker joined; an independent supervision scope remains paused' :
        'Worker supervision started; ordinary task messages remain supervised', 'info');
    } catch (error) {
      // The owner may have accepted before the response was lost. Fence delivery,
      // retain the confirmed nonce/history, and never retry this request blindly.
      hold = true; holdReason = 'restored'; stopVersion++;
      if (worker === record) await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
      report('start worker', error, ctx);
    }
  };

  pi.on('before_agent_start', (event) => {
    if (initialPending && worker === initialPending.worker && !hold &&
        stopVersion === initialPending.version && event.messageType === 'user' &&
        event.prompt === initialPending.message) initialPending.matched = true;
  });
  pi.on('agent_start', (_event, ctx) => {
    if (initialPending && worker === initialPending.worker && initialPending.matched &&
        stopVersion === initialPending.version && !hold) {
      clearTimeout(initialPending.timer);
      initialPending = undefined;
      ctx.ui.notify('Initial user turn started', 'info');
    }
    stopVersion++;
    if (!worker) return;
    previousAssistantId = lastAssistantId(ctx);
    // Every new turn invalidates the previous stop, including a human prompt.
    parkedReport = undefined;
    return observe({ session: currentSession(ctx), outcome: 'working', stop: null }, ctx);
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!worker || ctx.mode !== 'tui') return;
    if (initialPending) {
      clearTimeout(initialPending.timer);
      initialPending = undefined;
      hold = true; // A different turn must not substitute for the requested first turn.
    }
    stopVersion++;
    if (event.aborted || [...ctx.sessionManager.getBranch()].reverse().find(e =>
      e.type === 'message' && e.message?.role === 'assistant')?.message?.stopReason === 'error') {
      hold = true;
      holdReason = event.aborted ? 'interruption' : 'error';
      parkedReport = undefined;
    }
    try {
      const stopped = stopObservation(ctx, event.aborted, hold, stopVersion, previousAssistantId);
      if (stopped.outcome === 'approval') hold = true;
      await observe(stopped, ctx);
    } catch (error) { worker = undefined; report('observe settled turn', error, ctx); }
  });
  pi.registerCommand('continuation-worker-clear-hold', {
    description: 'Clear a resolved hold and allow current-report reassessment; not approval or activation',
    handler: async (_args, ctx) => {
      if (!worker || !hold || ctx.mode !== 'tui') return;
      const guard = promptsFor(ctx);
      const record = worker;
      const version = stopVersion;
      const session = currentSession(ctx);
      let prior;
      if (reviewCurrentReports) {
        await pendingWrite;
        try { prior = await readObservation(root, record.workerId); }
        catch (error) { report('read held report', error, ctx); return; }
      }
      if (!await guard.confirm('Clear worker hold?',
        'Only clear after resolving the hold reason. The current unchanged report may be reassessed. ' +
        'This is not action approval or scope activation; other pauses, budgets and no-replay guards remain.')) {
        await pendingWrite;
        return;
      }
      const now = currentSession(ctx);
      if (worker !== record || stopVersion !== version || now.id !== session.id ||
          now.file !== session.file || now.leaf !== session.leaf || !ctx.isIdle()) {
        ctx.ui.notify('Worker changed during confirmation; hold retained.', 'warning'); return;
      }
      const currentReport = prior ? currentHeldReport(prior, ctx, version, now) ??
        (worker.managedInput && prior.parkedReport ? currentHeldReport(prior.parkedReport, ctx, version, now) : null) : null;
      hold = false;
      holdReason = undefined;
      parkedReport = undefined;
      stopVersion++;
      await observe(currentReport ?? { session: now, outcome: 'unknown', stop: null }, ctx);
    },
  });
  pi.on('session_shutdown', async () => {
    if (preparing) preparing.interrupted = true;
    if (initialPending) { clearTimeout(initialPending.timer); initialPending = undefined; }
    stopVersion++;
    worker = undefined;
    stopTerminalInput?.();
    stopTerminalInput = undefined;
    await pendingWrite;
    await closeReceiver?.();
    closeReceiver = undefined;
    prompts?.dispose(); prompts = undefined; promptUI = undefined;
  });
  // UI prompts and tool errors hold subsequent stops until explicitly inspected.
  // Prose-only approval requests have no host signal; the pinned reply is
  // supervisor review evidence, never permission by itself.
  return { get registered() { return !!worker; }, get hold() { return hold; } };
}
