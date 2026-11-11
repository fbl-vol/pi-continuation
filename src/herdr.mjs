import net from 'node:net';
import { randomUUID } from 'node:crypto';

// Herdr's managed Pi integration maps its injected socket name to a Windows pipe.
export function endpoint(socketPath, platform = process.platform) {
  if (!socketPath) throw new Error('Herdr socket is not configured');
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

export function request(socketPath, method, params, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(endpoint(socketPath));
    let buffer = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Herdr request timed out')), timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2_000_000) return finish(new Error('Herdr response too large'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        if (response.id !== id) throw new Error('Herdr response id mismatch');
        if (response.error) throw new Error(`Herdr: ${response.error.code ?? 'unknown'}`);
        if (!response.result) throw new Error('Herdr response missing result');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('Herdr disconnected before response')));
  });
}

export async function snapshot(socketPath) {
  const response = await request(socketPath, 'session.snapshot', {});
  if (response.type !== 'session_snapshot' || response.snapshot?.protocol !== 22 ||
      !Array.isArray(response.snapshot.agents)) {
    throw new Error('Unsupported Herdr snapshot/protocol (expected 22)');
  }
  return response.snapshot;
}

export function sameOccupant(agent, binding) {
  const ref = agent?.agent_session;
  return agent?.agent === 'pi' && agent.pane_id === binding.paneId &&
    agent.terminal_id === binding.terminalId &&
    agent.workspace_id === binding.workspaceId && agent.tab_id === binding.tabId &&
    (agent.foreground_cwd || agent.cwd) === binding.cwd && ref?.source === 'herdr:pi' && ref.agent === 'pi' &&
    ref.kind === binding.sessionKind && ref.value === binding.sessionValue;
}
