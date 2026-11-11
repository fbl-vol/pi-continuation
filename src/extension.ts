import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { firstExtensionIs } from './launch.mjs';
import { bindObservation } from './observation.mjs';
import { bindSupervisor } from './supervisor.mjs';
import { bindCoordinator } from './coordinator.mjs';

// Installed but inert until a human explicitly registers this exact TUI session.
export default function (pi: ExtensionAPI) {
  bindObservation(pi, { launchGuard: () => firstExtensionIs(fileURLToPath(import.meta.url)) });
  bindSupervisor(pi);
  bindCoordinator(pi);
}
