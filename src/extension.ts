import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';

// Installed but inert until a human explicitly registers this exact TUI session.
export default function (pi: ExtensionAPI) {
  bindObservation(pi);
  bindSupervisor(pi);
  bindCoordinator(pi);
}
