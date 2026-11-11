import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, defaultRoot, ensureRoot, readJson } from './store.mjs';
import { receive } from './receiver.mjs';
import { currentSession } from './session.mjs';
import { SCHEMA_VERSION, readObservation } from './contracts.mjs';
import { diagnostics } from './diagnostics.mjs';

export function stopObservation(ctx, aborted, hold, version, previousAssistantId) {
  const session = currentSession(ctx);
  const last = [...ctx.sessionManager.getBranch()].reverse().find(e =>
    e.type === 'message' && e.message?.role === 'assistant');
  const outcome = aborted ? 'aborted' : last?.id !== previousAssistantId &&
    last?.message?.stopReason === 'error' ? 'error' : hold ? 'approval' :
    last?.id !== previousAssistantId && last?.message?.stopReason === 'stop' ? 'completed' : 'unknown';
  return { session, outcome, stop: randomUUID(), version, at: new Date().toISOString() };
}

export function bindObservation(pi, { root = defaultRoot(), socketPath = process.env.HERDR_SOCKET_PATH,
  paneId = process.env.HERDR_PANE_ID } = {}) {
  let worker;
  const report = diagnostics('worker');
  let hold = false;
  let stopVersion = 0;
  let previousAssistantId;
  const lastAssistantId = ctx => [...ctx.sessionManager.getBranch()].reverse().find(e =>
    e.type === 'message' && e.message?.role === 'assistant')?.id;
  let closeReceiver;
  let pendingWrite = Promise.resolve();
  const startReceiver = async ctx => {
    if (!worker) return;
    closeReceiver = await receive(root, worker, pi, ctx, () => stopVersion, () => hold || !worker);
  };
  pi.on('input', (event, ctx) => {
    if (event.source !== 'interactive' && event.source !== 'rpc') return;
    stopVersion++;
    if (worker) return observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
  });
  const observe = (value, ctx) => {
    const owner = worker;
    // Hold is independent of activity: a new turn must not erase an unresolved stop.
    const saved = { ...value, schemaVersion: SCHEMA_VERSION, hold, version: stopVersion };
    pendingWrite = pendingWrite.then(() => atomicJson(`${root}/observation-${owner.workerId}.json`, saved))
      .then(() => true)
      .catch(error => {
        if (worker === owner) worker = undefined;
        report('persist observation', error, ctx);
        return false;
      });
    return pendingWrite;
  };
  pi.on('ui_prompt_start', (_event, ctx) => {
    if (!worker) return; // Registration's own confirmation is not a worker approval hold.
    hold = true;
    stopVersion++;
    void observe({ session: currentSession(ctx), outcome: 'approval', stop: null, version: stopVersion }, ctx);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    if (!event.isError || !worker) return;
    hold = true;
    stopVersion++;
    return observe({ session: currentSession(ctx), outcome: 'error', stop: null }, ctx);
  });

  pi.on('session_start', async (_event, ctx) => {
    worker = undefined;
    if (ctx.mode !== 'tui' || !socketPath || !paneId || process.env.HERDR_ENV !== '1') return;
    // A fork/new session has a different ID. A copied session entry never binds it.
    const session = currentSession(ctx);
    const entries = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' &&
      e.customType === 'pi-continuation-worker');
    const binding = entries.at(-1)?.data;
    if (!binding || binding.sessionId !== session.id || binding.paneId !== paneId) return;
    try {
      await ensureRoot(root);
      const record = await readJson(`${root}/worker-${binding.workerId}.json`);
      if (record.sessionId === session.id && record.paneId === paneId && record.sessionFile === session.file) {
        worker = record;
        try {
          const prior = await readObservation(root, worker.workerId);
          hold = prior.hold;
          if (Number.isSafeInteger(prior.version) && prior.version >= 0) stopVersion = prior.version;
        } catch (error) { hold = true; report('restore observation', error, ctx); }
        if (!ctx.isIdle()) previousAssistantId = lastAssistantId(ctx);
        await startReceiver(ctx);
      }
    } catch (error) { worker = undefined; report('restore registration', error, ctx); }
  });

  pi.registerCommand('continuation-worker', {
    description: 'Register this exact Pi session for observation; usage: /continuation-worker <checkpoint path>',
    handler: async (argument, ctx) => {
      if (ctx.mode !== 'tui' || !socketPath || !paneId || process.env.HERDR_ENV !== '1') {
        ctx.ui.notify('Requires a Herdr-managed Pi TUI with its integration', 'error'); return;
      }
      if (worker) { ctx.ui.notify(`Already registered: ${worker.workerId} (observation only)`, 'info'); return; }
      const checkpoint = resolve(ctx.cwd, argument.trim());
      try { await access(checkpoint); } catch {
        ctx.ui.notify('Existing checkpoint path required', 'error'); return;
      }
      const session = currentSession(ctx);
      if (!await ctx.ui.confirm('Register continuation worker?',
        `Bind this session and checkpoint for observation only?\n${checkpoint}`)) return;
      await ensureRoot(root);
      const record = { workerId: randomUUID(), sessionId: session.id, sessionFile: session.file,
        paneId, checkpoint, cwd: ctx.cwd, socketPath, paused: true };
      await atomicJson(`${root}/worker-${record.workerId}.json`, record);
      pi.appendEntry('pi-continuation-worker', { workerId: record.workerId,
        sessionId: record.sessionId, paneId });
      worker = record;
      if (!await observe({ session, outcome: 'unknown', stop: null }, ctx)) return;
      try { await startReceiver(ctx); }
      catch (error) { worker = undefined; throw report('start receiver', error); }
      ctx.ui.notify(`Worker ${record.workerId} registered paused; no continuation is active`, 'info');
    },
  });

  pi.on('agent_start', (_event, ctx) => {
    stopVersion++;
    if (!worker) return;
    previousAssistantId = lastAssistantId(ctx);
    // Every new turn invalidates the previous stop, including a human prompt.
    return observe({ session: currentSession(ctx), outcome: 'working', stop: null }, ctx);
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!worker || ctx.mode !== 'tui') return;
    stopVersion++;
    if (event.aborted || [...ctx.sessionManager.getBranch()].reverse().find(e =>
      e.type === 'message' && e.message?.role === 'assistant')?.message?.stopReason === 'error') hold = true;
    try {
      await observe(stopObservation(ctx, event.aborted, hold, stopVersion, previousAssistantId), ctx);
    } catch (error) { worker = undefined; report('observe settled turn', error, ctx); }
  });
  pi.registerCommand('continuation-worker-clear-hold', {
    description: 'Explicitly clear a worker hold after inspecting the stop; does not activate supervision',
    handler: async (_args, ctx) => {
      if (!worker || !hold || ctx.mode !== 'tui') return;
      if (!await ctx.ui.confirm('Clear worker hold?',
        'Only clear after resolving the user stop, failed tool or pending approval. Old stops cannot be resumed.')) return;
      hold = false;
      stopVersion++;
      await observe({ session: currentSession(ctx), outcome: 'unknown', stop: null }, ctx);
    },
  });
  pi.on('session_shutdown', async () => {
    stopVersion++;
    worker = undefined;
    await pendingWrite;
    await closeReceiver?.();
    closeReceiver = undefined;
  });
  // UI prompts and tool errors hold subsequent stops until explicitly inspected.
  // Prose-only approval requests have no host signal; do not classify them as permission.
  return { get registered() { return !!worker; }, get hold() { return hold; } };
}
