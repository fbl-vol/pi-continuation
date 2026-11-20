import { sameOccupant } from './herdr.mjs';

// Presentation only: none of these labels grants eligibility or changes policy.
export function workerStatus(state, binding, agent, observation) {
  const status = (label, kind) => ({ label, kind });
  if (binding.stopped) return status('Stopped', 'stopped');
  if (!sameOccupant(agent, binding)) return status('Unavailable', 'unavailable');
  if (!observation || observation.session.id !== binding.sessionId ||
      observation.session.file !== binding.sessionFile) return status('Status unknown', 'unavailable');
  if (state.inflight[binding.workerId] || Object.values(state.notices).some(n =>
    n.workerId === binding.workerId && ['sending', 'uncertain'].includes(n.status)))
    return status('Held: delivery', 'held');
  const disposition = state.dispositions[binding.workerId];
  if (binding.paused && disposition?.action === 'decision' && disposition.stop === observation.stop)
    return status('Held: decision', 'held');
  if (agent.agent_status === 'blocked') return status('Held: prompt', 'held');
  if (observation.hold || (binding.paused && binding.failure &&
      binding.reason !== 'Explicit worker pause')) {
    if (observation.hold && observation.holdError?.kind === 'run') return status('Held: run failed', 'held');
    if (observation.hold && observation.holdError?.kind === 'checkpoint') return status('Held: checkpoint', 'held');
    if (binding.failure) return status('Held: error', 'held');
    const reason = observation.holdReason;
    return status(reason === 'error' ? 'Held: error' :
      reason === 'prompt' ? 'Held: prompt' : reason === 'interruption' ? 'Held: interruption' : 'Held', 'held');
  }
  if (binding.paused) return status('Paused', 'paused');
  if (state.paused) return status('Paused: global', 'paused');
  if (state.routes[binding.route]?.paused) return status('Paused: workspace', 'paused');
  return status('Supervised', 'active');
}

export function displayName(agent, fallback, paneLabel) {
  for (const value of [paneLabel, agent?.name, agent?.terminal_title_stripped, fallback]) {
    const name = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
    if (name) return name.slice(0, 80);
  }
  return '';
}
