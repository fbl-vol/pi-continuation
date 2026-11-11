import net from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

export function workerEndpoint(root, id, platform = process.platform) {
  const rootId = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return platform === 'win32' ? `\\\\.\\pipe\\pi-continuation-${rootId}-${id}` :
    join(root, `worker-${id}.sock`);
}

const failure = code => Object.assign(new Error(code), { code });

// One bounded UTF-8 frame per connection. No retry: a lost response may follow an effect.
function requestLine(address, line, limit, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.setEncoding('utf8');
    let buffer = '';
    let finished = false;
    const timer = setTimeout(() => done(failure('IPC_TIMEOUT')), timeout);
    function done(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.on('connect', () => socket.write(line + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > limit) return done(failure('IPC_FRAME'));
      const end = buffer.indexOf('\n');
      if (end >= 0) done(null, buffer.slice(0, end));
    });
    socket.on('error', done);
    socket.on('end', () => done(failure('IPC_CLOSED')));
  });
}

async function listenLine(address, limit, handle, reject, onError) {
  const idle = new Set();
  const server = net.createServer(socket => {
    idle.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(2500, () => socket.destroy());
    socket.on('error', () => {}); // A disconnected peer is not an application failure.
    socket.on('close', () => idle.delete(socket));
    let input = '';
    socket.on('data', async chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > limit) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      idle.delete(socket);
      try { socket.end(await handle(input.slice(0, end)) + '\n'); }
      catch (error) {
        onError(error);
        socket.end(reject + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.off('error', reject); resolve(); });
  });
  let closing;
  return () => closing ??= (async () => {
    const closed = new Promise(resolve => server.close(resolve));
    // Drain accepted handlers, but do not let an incomplete frame hold shutdown open.
    for (const socket of idle) socket.destroy();
    await closed;
    if (process.platform !== 'win32') await rm(address, { force: true });
  })();
}

// Policy stays in the role's handler, including receipt claims and final eligibility checks.
export function listenJson(root, id, handle, onError) {
  return listenLine(workerEndpoint(root, id), 8192, async line =>
    JSON.stringify(await handle(JSON.parse(line))), '{"accepted":false}', onError);
}

export async function sendAction(root, action, targetId = action.workerId) {
  return JSON.parse(await requestLine(workerEndpoint(root, targetId), JSON.stringify(action), 8192, 2500));
}

export function ownerServer(root, token) {
  return listenLine(workerEndpoint(root, 'supervisor'), 128,
    line => line === token ? token : 'invalid', 'invalid', () => {});
}

export async function ownerAlive(root, token) {
  try { return await requestLine(workerEndpoint(root, 'supervisor'), token, 128, 1000) === token; }
  catch { return false; } // A liveness challenge cannot grant authority on failure.
}
