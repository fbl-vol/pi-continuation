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
  if (observation.hold || (binding.paused && binding.failure)) {
    const reason = observation.holdReason;
    return status(reason === 'error' || binding.failure ? 'Held: error' :
      reason === 'prompt' ? 'Held: prompt' : reason === 'interruption' ? 'Held: interruption' : 'Held', 'held');
  }
  if (binding.paused) return status('Paused', 'paused');
  if (state.paused) return status('Paused: global', 'paused');
  if (state.routes[binding.route]?.paused) return status('Paused: workspace', 'paused');
  return status('Supervised', 'active');
}

export function displayName(agent, fallback) {
  return String(agent?.name || agent?.terminal_title_stripped || fallback)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 80);
}
