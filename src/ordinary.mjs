import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';
import { bindDelegation } from './delegation.mjs';
import { bindManagement } from './management.mjs';

/** Ordinary extension profile: explicit human controls, not exhaustive native UI coverage. */
export function bindContinuation(pi, options = {}) {
  // Only native one-shot delegated/supervisor startup selects an explicit
  // private state root; installation alone still enrolls nothing.
  options = { ...((process.env.PI_CONTINUATION_SPAWN || process.env.PI_CONTINUATION_SUPERVISOR_START) &&
    process.env.PI_CONTINUATION_ROOT ?
    { root: process.env.PI_CONTINUATION_ROOT } : {}), ...options };
  const worker = bindObservation(pi, { ...options, launchGuard: () => true, reviewCurrentReports: true });
  const supervisor = bindSupervisor(pi, { ...options, allowExperimentalActivation: true });
  const coordinator = bindCoordinator(pi, { ...options, confirmOwner: worker.confirmDelegation });
  bindDelegation(pi, worker, { ...options, registerOwner: coordinator.registerOwner });
  bindManagement(pi, worker, supervisor, coordinator, options);
  return worker;
}
