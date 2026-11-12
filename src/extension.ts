import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { bindContinuation } from './ordinary.mjs';

// Installed but inert until a human explicitly registers this exact TUI session.
export default function (pi: ExtensionAPI) {
  bindContinuation(pi);
}
