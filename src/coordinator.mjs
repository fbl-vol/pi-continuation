import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, ensureRoot, defaultRoot, claim, readJson } from './store.mjs';
import { workerEndpoint, ownerAlive } from './receiver.mjs';
import { currentSession } from './observation.mjs';

export function bindCoordinator(pi, { root = defaultRoot(), paneId = process.env.HERDR_PANE_ID } = {}) {
  let close;
  let coordinator;
  let generation = 0;
  let humanPending = false;
  let uiPromptActive = false;
  pi.on('input', event => {
    if (event.source === 'interactive' || event.source === 'rpc') {
      generation++;
      humanPending = true;
    }
  });
  pi.on('agent_start', () => { generation++; });
  pi.on('agent_settled', () => { humanPending = false; });
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
      coordinator = record;
      close = await listen(record, ctx);
    } catch { coordinator = undefined; }
  });

  async function listen(record, ctx) {
    const address = workerEndpoint(root, record.id);
    const server = net.createServer(socket => {
      let input = '';
      socket.on('data', async chunk => {
        input += chunk.toString();
        if (input.length > 8192) { socket.destroy(); return; }
        const end = input.indexOf('\n');
        if (end < 0) return;
        socket.removeAllListeners('data');
        try {
          const notice = JSON.parse(input.slice(0, end));
          const state = await readJson(join(root, 'supervisor.json'));
          const owner = await readJson(join(root, 'supervisor.lock'));
          const route = state.routes?.[notice.route];
          const now = currentSession(ctx);
          const version = generation;
          if (!await ownerAlive(root, owner.token) ||
              state.paused || route?.paused || route?.coordinator?.id !== record.id ||
              notice.ownerToken !== owner.token || owner.token !== state.ownerToken ||
              now.id !== record.sessionId || now.file !== record.sessionFile ||
              notice.id !== state.notices?.[notice.id]?.id || state.notices[notice.id].status !== 'sending') {
            socket.end('{"accepted":false}\n'); return;
          }
          if (humanPending || uiPromptActive || !ctx.isIdle()) {
            // No receipt was claimed and no effect can have happened. This is
            // retryable, unlike a disconnect or a rejection after acceptance.
            socket.end(JSON.stringify({ accepted: false, deferred: true, id: notice.id }) + '\n');
            return;
          }
          await claim(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'accepted' });
          const latest = await readJson(join(root, 'supervisor.json'));
          if (latest.paused || latest.routes?.[notice.route]?.paused ||
              latest.routes?.[notice.route]?.coordinator?.id !== record.id ||
              humanPending || uiPromptActive || !ctx.isIdle() || generation !== version || currentSession(ctx).leaf !== now.leaf) {
            socket.end('{"accepted":false}\n'); return;
          }
          pi.sendMessage({ customType: 'pi-continuation-notice', display: true,
            content: `Material ${notice.kind} notice for registered worker ${notice.workerId}: ${notice.text}. This is information, not approval authority.` },
          { triggerTurn: true });
          await atomicJson(join(root, `receipt-${notice.id}.json`), { id: notice.id, status: 'sent' });
          socket.end(JSON.stringify({ accepted: true, id: notice.id }) + '\n');
        } catch { socket.end('{"accepted":false}\n'); }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => { server.off('error', reject); resolve(); });
    });
    return async () => {
      await new Promise(resolve => server.close(resolve));
      if (process.platform !== 'win32') await rm(address, { force: true });
    };
  }

  pi.registerCommand('continuation-coordinator', {
    description: 'Register this exact Pi session as a material-notice recipient; does not grant approval',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !paneId || process.env.HERDR_ENV !== '1')
        throw new Error('Requires a Herdr-managed Pi TUI');
      if (coordinator) { ctx.ui.notify(`Coordinator already registered: ${coordinator.id}`); return; }
      if (!await ctx.ui.confirm('Register coordinator?', 'Receive material notices in this exact session; no continuation or approval authority.')) return;
      await ensureRoot(root);
      const session = currentSession(ctx);
      coordinator = { id: randomUUID(), sessionId: session.id, sessionFile: session.file,
        cwd: ctx.cwd, paneId };
      await atomicJson(join(root, `coordinator-${coordinator.id}.json`), coordinator);
      pi.appendEntry('pi-continuation-coordinator', { id: coordinator.id,
        sessionId: session.id, paneId });
      close = await listen(coordinator, ctx);
      ctx.ui.notify(`Coordinator ${coordinator.id} registered`);
    },
  });
  pi.on('session_shutdown', async () => { generation++; coordinator = undefined; await close?.(); close = undefined; });
}
