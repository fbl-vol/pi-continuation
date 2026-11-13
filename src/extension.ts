import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { bindContinuation } from './ordinary.mjs';

// Installed but inert until a human explicitly registers this exact TUI session.
export default function (pi: ExtensionAPI) {
  bindContinuation(pi, { isInterrupt: data => matchesKey(data, 'escape') });
}
