import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';

/** Ordinary extension profile: explicit human controls, not exhaustive native UI coverage. */
export function bindContinuation(pi, options = {}) {
  const worker = bindObservation(pi, { ...options, launchGuard: () => true, reviewCurrentReports: true });
  bindSupervisor(pi, { ...options, allowExperimentalActivation: true });
  bindCoordinator(pi, options);
  return worker;
}
