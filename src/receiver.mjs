import net from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { readJson, atomicJson, claim } from './store.mjs';
import { currentSession } from './observation.mjs';

export function workerEndpoint(root, workerId, platform = process.platform) {
  const rootId = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return platform === 'win32' ? `\\\\.\\pipe\\pi-continuation-${rootId}-${workerId}` :
    join(root, `worker-${workerId}.sock`);
}

// Never start this listener without an explicitly registered native worker session.
export async function receive(root, worker, pi, context, stopVersion) {
  const address = workerEndpoint(root, worker.workerId);
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', async chunk => {
      input += chunk.toString('utf8');
      if (input.length > 8192) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      const line = input.slice(0, end);
      socket.removeAllListeners('data');
      let action;
      try { action = JSON.parse(line); }
      catch { socket.end('{"accepted":false}\n'); return; }
      try {
        const response = await accept(root, worker, action, context, pi, stopVersion);
        socket.end(JSON.stringify(response) + '\n');
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

export async function accept(root, worker, action, ctx, pi, stopVersion = () => 0) {
  if (!action || typeof action.id !== 'string' || !/^[a-f0-9-]{36}$/.test(action.id))
    return { accepted: false, reason: 'invalid action' };
  const state = await readJson(join(root, 'supervisor.json'));
  const owner = await readJson(join(root, 'supervisor.lock'));
  const binding = state.workers?.[worker.workerId];
  const observation = await readJson(join(root, `observation-${worker.workerId}.json`));
  const intent = await readJson(join(root, `intent-${action.id}.json`));
  const session = currentSession(ctx);
  const version = stopVersion();
  if (observation.version !== version || !await ownerAlive(root, owner.token))
    return { accepted: false, reason: 'stop changed or supervisor unavailable' };
  // The whole check-to-injection interval is synchronous after these reads. If
  // anything changes during the reads, the worker's stop identity is checked again.
  if (ctx.mode !== 'tui' || !ctx.isIdle() || owner.token !== state.ownerToken ||
      owner.token !== action.ownerToken || owner.pid !== state.ownerPid ||
      state.paused ||
      state.routes?.[binding?.route]?.paused !== false || binding?.paused !== false ||
      binding?.sessionId !== worker.sessionId || action.workerId !== worker.workerId ||
      action.id !== intent.id || intent.status !== 'sending' ||
      intent.ownerToken !== owner.token || intent.stop !== action.stop ||
      observation.outcome !== 'completed' || observation.stop !== action.stop ||
      observation.session.id !== session.id || observation.session.file !== session.file ||
      observation.session.leaf !== session.leaf || session.id !== worker.sessionId ||
      session.file !== worker.sessionFile) {
    return { accepted: false, reason: 'stale or paused' };
  }
  // A crash between receipt persistence and send is ambiguous: the supervisor
  // must suspend and inspect rather than repeat this action.
  try { await claim(join(root, `receipt-${action.id}.json`), { id: action.id, status: 'accepted' }); }
  catch (error) {
    if (error.code === 'EEXIST') return { accepted: false, reason: 'duplicate action' };
    throw error;
  }
  const latest = await readJson(join(root, 'supervisor.json'));
  if (latest.paused || latest.routes?.[binding.route]?.paused !== false ||
      latest.workers?.[worker.workerId]?.paused !== false || latest.ownerToken !== owner.token ||
      !ctx.isIdle() || stopVersion() !== version || currentSession(ctx).leaf !== session.leaf) {
    return { accepted: false, reason: 'session changed after receipt' };
  }
  pi.sendMessage({ customType: 'pi-continuation',
    content: `Continue the already approved assignment from your existing checkpoint. Do not bypass pauses, approvals, or review requirements. Action ${action.id}.`,
    display: true }, { triggerTurn: true });
  await atomicJson(join(root, `receipt-${action.id}.json`), { id: action.id, status: 'sent' });
  return { accepted: true, id: action.id };
}

export async function ownerAlive(root, token) {
  return new Promise(resolve => {
    const socket = net.createConnection(workerEndpoint(root, 'supervisor'));
    let buffer = '';
    const timer = setTimeout(() => done(false), 1000);
    const done = ok => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    socket.on('connect', () => socket.write(`${token}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) done(buffer.slice(0, buffer.indexOf('\n')) === token);
      if (buffer.length > 128) done(false);
    });
    socket.on('error', () => done(false));
    socket.on('end', () => done(false));
  });
}
