import { randomUUID } from 'node:crypto';
import { access, lstat, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicJson, atomicText, claim, defaultRoot, ensureRoot, readJson } from './store.mjs';
import { delegatedStart, delegationAuthority, requireDelegationParent, spawnPath } from './delegation.mjs';
import { sameOccupant, isSettled, snapshot } from './herdr.mjs';
import { ownerAlive, sendAction } from './ipc.mjs';
import { managedCheckpointPath, managedCheckpointText } from './checkpoint.mjs';
import { checkpointHash } from './policy.mjs';
import { receive } from './receiver.mjs';
import { currentSession } from './session.mjs';
import { readyWorkerRegistration } from './bindings.mjs';
import { commitReady } from './registration.mjs';
import { SCHEMA_VERSION, MAX_FINAL_REPLY_BYTES, readObservation, readSupervisor, isId } from './contracts.mjs';
import { diagnostics, workerStartRefusal } from './diagnostics.mjs';
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
  let holdError;
  let parkedReport;
  let lastObserved;
  let stopVersion = 0;
  let commandReport;
  let commandLeaf;
  let shutdownVersion;
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
      holdError = undefined;
    }
    parkedReport = undefined;
    commandReport = undefined;
    commandLeaf = undefined;
    return observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
  });
  const observe = (value, ctx) => {
    const owner = worker;
    // Hold is independent of activity: a new turn must not erase an unresolved stop.
    const saved = { ...value, schemaVersion: SCHEMA_VERSION, hold, version: stopVersion,
      holdReason: owner.managedInput && hold ? holdReason ?? 'restored' : undefined,
      holdError: hold ? holdError : undefined,
      parkedReport: owner.managedInput ? parkedReport : undefined,
      commandReport: owner.managedInput && holdReason === 'typing' ? commandReport : undefined,
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
        holdError = { kind: 'checkpoint', at: new Date().toISOString() };
        await atomicJson(`${root}/observation-${owner.workerId}.json`, {
          ...saved, outcome: 'error', stop: null, hold: true, holdReason: 'error', holdError, parkedReport: undefined,
          ...(checkpoint !== undefined && saved.outcome === 'completed' && !saved.hold &&
            saved.stop && saved.finalReply ?
            { checkpointRecovery: { report: saved, hash: checkpointHash(checkpoint) } } : {}),
        });
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
  const recoverCheckpoint = async (prior, ctx, restoringFromShutdown) => {
    const recovery = prior.checkpointRecovery;
    if (!recovery || prior.holdError?.kind !== 'checkpoint' || !ctx.isIdle() || prompts.blocked ||
        !(prior.version === stopVersion || (restoringFromShutdown && prior.version === stopVersion - 1))) return;
    const session = currentSession(ctx);
    const report = currentHeldReport({ ...recovery.report, hold: true, outcome: 'approval' },
      ctx, prior.version, session);
    if (!report) return;
    const checkpoint = managedCheckpointText(ctx);
    if (checkpointHash(checkpoint) !== recovery.hash) return;
    // This is fresh durable evidence for the unchanged native report, not a
    // replay of its turn or permission to clear an independent supervisor pause.
    const record = worker;
    const version = stopVersion;
    const recovered = { ...recovery.report, version: version + 1, hold: false };
    const writing = pendingWrite.then(async () => {
      await atomicText(record.checkpoint, checkpoint);
      if (worker !== record || stopVersion !== version || prompts.blocked || !ctx.isIdle() ||
          !currentHeldReport({ ...recovery.report, hold: true, outcome: 'approval' },
            ctx, prior.version, currentSession(ctx))) return false;
      await atomicJson(`${root}/observation-${record.workerId}.json`, recovered);
      return true;
    });
    // An input arriving while the file is being replaced must persist *after*
    // this candidate; it cannot be overwritten by the old stop.
    pendingWrite = writing.then(() => true, () => false);
    if (!await writing || worker !== record || stopVersion !== version) return;
    stopVersion++;
    hold = false; holdReason = undefined; holdError = undefined;
    lastObserved = recovered;
    return { stop: recovered.stop, reportHash: recovery.hash };
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
    if (existing.outcome === 'error') {
      holdReason = 'error';
      holdError = { kind: 'run', at: new Date().toISOString() };
    }
    return observe(existing, ctx);
  };
  const watchTerminalInput = ctx => {
    // Fence immediately, even before Pi knows whether typing will submit a task
    // or open a native menu. Only a confirmed start may recover a parked report.
    stopTerminalInput = ctx.ui.onTerminalInput(data => {
      if (preparing) { preparing.interrupted = true; stopVersion++; return; }
      // Native dialog keys reach this hook too. Our own confirmation must not
      // fence itself; Escape and concurrent external UI still interrupt it.
      if (prompts?.confirming && !isInterrupt(data)) return;
      if (!worker || (hold && (!worker.managedInput || !isInterrupt(data)))) return;
      if (worker.managedInput && !hold) {
        parkedReport = lastObserved?.stop ? lastObserved : undefined;
        commandReport = lastObserved?.outcome === 'completed' && !lastObserved.hold ? lastObserved : undefined;
        commandLeaf = currentSession(ctx).leaf;
      }
      if (isInterrupt(data)) { commandReport = undefined; commandLeaf = undefined; }
      hold = true;
      holdReason = isInterrupt(data) ? 'interruption' : 'typing';
      holdError = undefined;
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
    holdError = undefined;
    parkedReport = undefined;
    commandReport = undefined; commandLeaf = undefined;
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
  pi.on('tool_execution_end', event => {
    // Setup remains provisional. During a normal run, Pi may recover a failed
    // tool; only the settled outcome and existing prompt/input guards latch holds.
    if (event.isError && preparing) { preparing.interrupted = true; stopVersion++; }
  });

  pi.on('session_start', async (_event, ctx) => {
    const restoringFromShutdown = shutdownVersion === stopVersion;
    shutdownVersion = undefined;
    if (preparing) preparing.interrupted = true;
    if (initialPending) { clearTimeout(initialPending.timer); initialPending = undefined; }
    stopTerminalInput?.();
    stopTerminalInput = undefined;
    worker = undefined;
    holdReason = undefined; holdError = undefined; parkedReport = undefined; lastObserved = undefined;
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
          holdError = hold && !promptInterrupted ? prior.holdError : undefined;
          parkedReport = promptInterrupted ? undefined : prior.parkedReport;
          lastObserved = prior;
          if (Number.isSafeInteger(prior.version) && prior.version >= 0)
            stopVersion = Math.max(stopVersion, prior.version);
        } catch (error) { hold = true; report('restore observation', error, ctx); }
        const recovered = !promptInterrupted && await recoverCheckpoint(lastObserved, ctx, restoringFromShutdown);
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
        if (recovered) {
          try {
            await sendAction(root, { type: 'checkpoint-recovered', workerId: worker.workerId,
              sessionId: session.id, sessionFile: session.file, stop: recovered.stop,
              reportHash: recovered.reportHash }, 'supervisor');
          } catch (error) { report('request checkpoint reassessment', error, ctx); }
        }
      }
    } catch (error) {
      worker = undefined;
      stopTerminalInput?.();
      stopTerminalInput = undefined;
      report('restore registration', error, ctx);
    }
  });

  const requestStart = async ctx => {
    if (starting) { ctx.ui.notify('Worker start is already in progress', 'info'); return; }
    starting = true;
    try { return await startWorker(ctx); }
    finally { starting = false; }
  };
  pi.registerCommand('continuation-worker', {
    description: 'Start or return to supervision (default): [start] | advanced registration: <checkpoint> or --start {"checkpoint":"/path","message":"task"}',
    handler: (argument, ctx) => {
      const input = argument.trim();
      return !input || input === 'start' ? requestStart(ctx) : registerWorker(argument, ctx);
    },
  });

  const registerWorker = async (argument, ctx, managed = false, delegated, stillEligible = () => true,
    ownerEntry) => {
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
      if (!managed) {
        try {
          if (!(await stat(checkpoint)).isFile()) {
            ctx.ui.notify('Checkpoint must be an existing file, not a directory or other resource', 'error'); return;
          }
        } catch {
          ctx.ui.notify('Existing checkpoint file required', 'error'); return;
        }
      }
      const session = currentSession(ctx);
      if (!stillEligible() || guard.blocked || guard.revision !== registrationRevision || stopVersion !== registrationVersion) {
        ctx.ui.notify('Registration interrupted by another interaction; inspect before retrying.', 'warning'); return;
      }
      if (!delegated && !await guard.confirm(managed ? 'Start worker supervision?' : 'Register continuation worker?', managed ?
        'Join the running supervisor and enable this exact session. Ordinary task messages remain supervised; Escape, prompts and errors stop it. Confirm no other continuation owner supervises this worker.' :
        `Bind this session and checkpoint for observation?\n${checkpoint}${initialMessage ?
          '\nStart the explicitly supplied initial user message after registration?' : ''}`)) return;
      if (stopVersion !== registrationVersion || guard.revision !== registrationRevision) {
        ctx.ui.notify('Registration interrupted during confirmation; no message sent.', 'warning'); return;
      }
      const record = { workerId, sessionId: session.id, sessionFile: session.file,
        paneId, checkpoint, cwd: ctx.cwd, socketPath, stateRoot: root, paused: true, requiresReady: true,
        ...(managed ? { managedInput: true, managedCheckpoint: true } : {}),
        ...(delegated ? { delegationId: delegated.id } : {}),
        ...(ownerEntry ? { role: 'owner', coordinatorId: ownerEntry.id } : {}) };
      const candidate = { interrupted: false, version: stopVersion };
      preparing = candidate;
      let receiver;
      let workerSaved = false;
      let observationSaved = false;
      let published = false;
      try {
        watchTerminalInput(ctx);
        await ensureRoot(root);
        // Pi allocates a journal path before its first conversation is persisted.
        // Pin that future path only for a confirmed, truly blank managed session;
        // never create the journal or a synthetic task to force native persistence.
        if (managed && !ctx.sessionManager.getEntries().some(entry =>
          entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role))) {
          try { await lstat(session.file); }
          catch (error) {
            if (error.code !== 'ENOENT') throw error;
            record.pendingSession = join(await realpath(dirname(session.file)), basename(session.file));
          }
        }
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
          return stillEligible() && !candidate.interrupted && candidate.version === stopVersion && !hold && !guard.blocked &&
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

  const startWorker = async (ctx, delegated, stillEligible) => {
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
    if (Object.values(supervisor.retiredWorkers).some(old => old.sessionId === session.id || old.sessionFile === session.file)) {
      ctx.ui.notify(workerStartRefusal('WORKER_RETIRED'), 'warning'); return;
    }
    const coordinatorEntry = entries.filter(entry => entry.type === 'custom' &&
      entry.customType === 'pi-continuation-coordinator' && entry.data?.sessionId === session.id).at(-1)?.data;
    if (session.id === supervisor.supervisorSession || (coordinatorEntry && coordinatorEntry.role !== 'owner')) {
      ctx.ui.notify('A supervisor or ordinary coordinator cannot become a worker', 'error'); return;
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
      await registerWorker('', ctx, true, delegated, stillEligible, coordinatorEntry);
      if (!worker) return;
    } else {
      const guard = promptsFor(ctx);
      const version = stopVersion;
      if (guard.blocked || (!ctx.isIdle() && hold && holdReason !== 'typing')) {
        ctx.ui.notify('Resolve the current interruption or prompt and wait until idle before start', 'warning'); return;
      }
      const stopped = supervisor.workers[worker.workerId]?.stopped;
      if (!await guard.confirm(stopped ? 'Return stopped worker to supervision?' : 'Return worker to supervision?',
        stopped ? 'Rejoin this exact worker after resolving its hold. Pre-existing worker, global and workspace pauses, budgets and delivery history remain unchanged. No unanswered decision is approved.' :
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
      hold = false; holdReason = undefined; holdError = undefined; parkedReport = undefined;
      stopVersion++;
      if (!await observe(currentReport ?? (unchanged ? prior :
        { session: now, outcome: ctx.isIdle() ? 'unknown' : 'working', stop: null }), ctx)) return;
    }
    const record = worker;
    if (!record) return;
    record.stateRoot = root;
    record.start = { nonce: delegated?.id ?? randomUUID(), ownerToken: supervisor.ownerToken,
      ...(supervisor.workers[record.workerId]?.stopped ?
        { returnToken: supervisor.workers[record.workerId].stopToken } : {}) };
    try {
      await atomicJson(`${root}/worker-${record.workerId}.json`, record);
      const sendJoin = () => sendAction(root, { type: 'worker-start', workerId: record.workerId,
        ...record.start }, 'supervisor');
      const guard = promptsFor(ctx);
      const version = stopVersion;
      const pinned = currentSession(ctx);
      const unchanged = () => {
        const now = currentSession(ctx);
        return worker === record && version === stopVersion && !guard.blocked &&
          now.id === pinned.id && now.file === pinned.file && now.leaf === pinned.leaf;
      };
      let result = await sendJoin();
      if (result.replacementRequired && result.workerId === record.workerId &&
          result.nonce === record.start.nonce && result.ownerToken === supervisor.ownerToken &&
          isId(result.replaceWorkerId) && unchanged()) {
        const replaceWorkerId = result.replaceWorkerId;
        if (await guard.confirm('Retire old worker registration and start this session?',
          `This pane has an older registration (${replaceWorkerId}). Retire it and register this session as a fresh worker? ` +
          'Old history is retained; no approvals, continuation budget or task authority are inherited. Other scope pauses remain unchanged.')) {
          if (unchanged()) {
            record.start = { nonce: randomUUID(), ownerToken: supervisor.ownerToken, replaceWorkerId };
            await atomicJson(`${root}/worker-${record.workerId}.json`, record);
            if (unchanged()) result = await sendJoin();
          }
        }
      }
      if (!result.accepted || result.workerId !== record.workerId || result.nonce !== record.start.nonce ||
          result.ownerToken !== supervisor.ownerToken) {
        hold = true; holdReason = 'restored'; stopVersion++;
        await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
        ctx.ui.notify(result.replacementRequired ?
          'Replacement not confirmed or worker changed; old registration retained, new worker held' :
          workerStartRefusal(result.code), 'warning'); return;
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
  pi.on('agent_start', async (_event, ctx) => {
    let delegatedReceipt;
    if (initialPending && worker === initialPending.worker && initialPending.matched &&
        stopVersion === initialPending.version && !hold) {
      clearTimeout(initialPending.timer);
      delegatedReceipt = initialPending.delegatedReceipt;
      initialPending = undefined;
      ctx.ui.notify('Initial user turn started', 'info');
    }
    stopVersion++;
    if (!worker) return;
    previousAssistantId = lastAssistantId(ctx);
    // Every new turn invalidates the previous stop, including a human prompt.
    parkedReport = undefined;
    commandReport = undefined; commandLeaf = undefined;
    const observed = await observe({ session: currentSession(ctx), outcome: 'working', stop: null }, ctx);
    if (observed && delegatedReceipt) await atomicJson(delegatedReceipt.path,
      { id: delegatedReceipt.id, status: 'sent' });
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
      // The latest failed outcome is separate from the origin of an unresolved
      // hold. Do not relabel an approval or replace its recorded failure time.
      if (!hold) {
        hold = true;
        holdReason = event.aborted ? 'interruption' : 'error';
        holdError = event.aborted ? undefined : { kind: 'run', at: new Date().toISOString() };
      }
      parkedReport = undefined;
    }
    try {
      const stopped = stopObservation(ctx, event.aborted, hold, stopVersion, previousAssistantId);
      if (stopped.outcome === 'approval') hold = true;
      await observe(stopped, ctx);
    } catch (error) { worker = undefined; report('observe settled turn', error, ctx); }
  });
  const clearHold = async ctx => {
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
    holdError = undefined;
    parkedReport = undefined;
    stopVersion++;
    await observe(currentReport ?? { session: now, outcome: 'unknown', stop: null }, ctx);
  };
  pi.on('session_shutdown', async () => {
    if (preparing) preparing.interrupted = true;
    if (initialPending) { clearTimeout(initialPending.timer); initialPending = undefined; }
    stopVersion++;
    shutdownVersion = stopVersion;
    worker = undefined;
    stopTerminalInput?.();
    stopTerminalInput = undefined;
    await pendingWrite;
    await closeReceiver?.();
    closeReceiver = undefined;
    prompts?.dispose(); prompts = undefined; promptUI = undefined;
  });
  // UI prompts, failed runs and interruptions hold until explicitly inspected.
  // Prose-only approval requests have no host signal; the pinned reply is
  // supervisor review evidence, never permission by itself.
  return {
    get registered() { return !!worker; }, get hold() { return hold; },
    get interactionVersion() { return stopVersion; },
    flushObservations() { return pendingWrite; },
    launchEvidence(ctx) {
      if (!worker || worker.role !== 'owner' || !hold || holdReason !== 'typing' ||
          !commandReport || commandLeaf !== currentSession(ctx).leaf ||
          commandReport.session?.id !== worker.sessionId || commandReport.session?.file !== worker.sessionFile ||
          !ctx.isIdle() || promptsFor(ctx).blocked ||
          lastObserved?.version !== stopVersion) return;
      return { workerId: worker.workerId, stop: commandReport.stop, version: stopVersion };
    },
    selectManagement(ctx, title, choices) { return promptsFor(ctx).select(title, choices); },
    inputDecision(ctx, title) { return promptsFor(ctx).input(title); },
    async finishDecisionCommand(ctx, evidence) {
      // Do not clear a real hold, only the exact provisional typing fence for this command.
      const typing = this.launchEvidence(ctx);
      if (!typing || typing.stop !== evidence.stop || typing.version !== evidence.version) return;
      const report = commandReport;
      hold = false; holdReason = undefined; parkedReport = undefined;
      commandReport = undefined; commandLeaf = undefined;
      stopVersion++;
      await observe(report, ctx);
    },
    start: requestStart, clearHold,
    get confirming() { return prompts?.confirming === true; },
    get promptBlocked() { return !prompts?.intact || prompts.blocked; },
    confirmDelegation(ctx, title, message) { return promptsFor(ctx).confirm(title, message); },
    async enrollDelegated(ctx, ticket, stillEligible) {
      if (worker || preparing || starting || !ctx.isIdle() || promptsFor(ctx).blocked || hold)
        throw new Error('Delegated enrollment requires a new idle unheld worker');
      const saved = await readJson(spawnPath(root, ticket.id));
      const session = currentSession(ctx);
      const owner = ctx.sessionManager.getBranch().find(e => e.type === 'custom' &&
        e.customType === 'pi-continuation-coordinator' && e.data?.role === 'owner' && e.data.sessionId === session.id);
      const record = { sessionId: session.id, sessionFile: session.file, paneId, cwd: ctx.cwd,
        start: { nonce: saved.id }, delegationId: saved.id,
        ...(owner ? { role: 'owner', coordinatorId: owner.data.id } : {}) };
      await delegatedStart(root, saved.id, record, await readSupervisor(root), await snapshot(socketPath));
      starting = true;
      try { await startWorker(ctx, saved, stillEligible); }
      finally { starting = false; }
    },
    async dispatchDelegated(ctx, ticket, message) {
      const record = worker;
      const session = currentSession(ctx);
      if (!record || record.delegationId !== ticket.id || record.workerId !== ticket.workerId ||
          record.sessionId !== ticket.child.sessionId || record.sessionFile !== ticket.child.sessionFile ||
          session.id !== record.sessionId || session.file !== record.sessionFile || hold ||
          promptsFor(ctx).blocked || !ctx.isIdle() || initialPending)
        throw new Error('Delegated assignment is not eligible');
      const version = stopVersion;
      const path = join(root, `spawn-receipt-${ticket.id}.json`);
      await claim(path, { id: ticket.id, status: 'accepted' });
      if (worker !== record || stopVersion !== version || hold || promptsFor(ctx).blocked ||
          !ctx.isIdle() || currentSession(ctx).leaf !== session.leaf)
        throw new Error('Delegated assignment changed before dispatch; inspect accepted receipt');
      const pending = { worker: record, message, version, matched: false,
        delegatedReceipt: { path, id: ticket.id } };
      initialPending = pending;
      // Retain bootstrap uncertainty across a crash/reload, before native dispatch.
      if (!await observe({ session, outcome: 'unknown', stop: null, bootstrapPending: true }, ctx))
        throw new Error('Could not persist delegated dispatch fence');
      const live = await snapshot(socketPath);
      requireDelegationParent(live, ticket.parent);
      const savedTicket = await readJson(spawnPath(root, ticket.id));
      const { state } = await delegationAuthority(root, ticket.authority, ticket.parent);
      const binding = state.workers[record.workerId];
      const agent = live.agents.find(a => a.pane_id === paneId);
      if (savedTicket.status !== 'dispatching' || state.ownerToken !== ticket.ownerToken ||
          !await ownerAlive(root, ticket.ownerToken) || state.paused || !binding || binding.paused ||
          state.routes[binding.route]?.paused || !sameOccupant(agent, binding) || !isSettled(agent) ||
          worker !== record || stopVersion !== version || hold || promptsFor(ctx).blocked || !ctx.isIdle() ||
          currentSession(ctx).id !== session.id || currentSession(ctx).file !== session.file)
        throw new Error('Delegated assignment interrupted before dispatch');
      pending.timer = setTimeout(() => {
        if (initialPending !== pending || worker !== record) return;
        initialPending = undefined; hold = true; holdReason = 'restored'; stopVersion++;
        void observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
      }, 10000);
      pending.timer.unref?.();
      try { pi.sendUserMessage(message); }
      catch (error) {
        clearTimeout(pending.timer); initialPending = undefined;
        hold = true; holdReason = 'restored'; stopVersion++;
        await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
        throw error;
      }
    },
  };
}
