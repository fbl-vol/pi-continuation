import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';
import { bindDelegation } from './delegation.mjs';

/** Ordinary extension profile: explicit human controls, not exhaustive native UI coverage. */
export function bindContinuation(pi, options = {}) {
  // Only a one-shot delegated startup selects an explicit private state root;
  // installation alone still enrolls nothing.
  options = { ...(process.env.PI_CONTINUATION_SPAWN && process.env.PI_CONTINUATION_ROOT ?
    { root: process.env.PI_CONTINUATION_ROOT } : {}), ...options };
  const worker = bindObservation(pi, { ...options, launchGuard: () => true, reviewCurrentReports: true });
  bindSupervisor(pi, { ...options, allowExperimentalActivation: true });
  bindCoordinator(pi, options);
  bindDelegation(pi, worker, options);
  return worker;
}
