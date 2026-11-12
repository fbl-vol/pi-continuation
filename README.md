# pi-continuation

An experimental, private **ordinary Pi extension** for explicitly registered Herdr-managed Pi TUI sessions. Load it through normal Pi package/extension startup; no SDK launcher, first-command-line-option rule or Pi fork is required. Installation alone registers and activates nothing.

**Not released, installed into live settings or accepted for existing workers.** The GitHub repository is public; npm publication is disabled (`private: true`). Linux, macOS and native Windows are targets, not verified runtime support claims. [The bounded parity scenarios](docs/extension-parity.md) define the outcome; [the contract](docs/contract.md) and [validation](docs/validation.md) describe protections and limits.

## What it does

- Pins a worker's current saved Pi session, checkpoint, terminal, pane, cwd and workspace. A replacement/fork never silently inherits registration.
- Uses Pi lifecycle/persistence/messaging and Herdr's existing identity/status reporting. The dedicated supervisor interprets the final reply and checkpoint against the **whole assignment**, including follow-ups. A favorable review alone is not completion; interpretation never grants new authority.
- Gives blocked workers attention even mid-turn, before an assistant stop exists. Herdr status evidence is explicitly labeled, not a fabricated worker reply or resumable native stop. Blocked/held workers cannot be resumed or declared complete. Genuine approval requests require a decision/pause, not invented approval.
- Keeps separate human-confirmed global, route and worker activation/pauses. Model tools cannot activate scopes or clear user holds. Escape, tool errors, observed shared-UI prompts and registered-worker keyboard input create sticky holds; closing a dialog or starting another turn does not clear them.
- Delivers through a worker-owned local receiver, not `agent.prompt`. A final Herdr identity/status/sequence check precedes addressed delivery; the receiver rechecks exact native stop, session, owner, hold and pauses. One-use receipts prevent replay. Uncertain delivery pauses for inspection, not retry.
- Bounds unchanged progress at two nudges and unresolved supervisor attention at one corrective wake before worker-local escalation. Material completion/blocker/decision notices go only to an exact coordinator; definite deferral stays pending, uncertainty pauses, stale completion is discarded.
- Retains selected-worker ownership fencing and paused handoff/rollback history. Source preparation is not authorization to install an adapter or migrate live supervision.

## Development and separately authorized disposable use

Run `npm ci --legacy-peer-deps`, `npm test`, and `npm run check:package`. Tests use fake sessions/transports, temporary state, loopback sockets and competing child processes—not real workers. The explicit package allowlist excludes tests, private records and experimental SDK launcher/resources. Pi 1.5.0 and Herdr protocol 22 are the development baseline, not a cross-platform certification.

Only for a **separately authorized disposable** environment, `pi install /absolute/path/to/pi-continuation` installs the normal package (and changes Pi settings). Start/reload Pi through its ordinary loading mechanism; no special launcher or first `-e` ordering is required. The intended command sequence is:

1. In an existing worker, `/continuation-worker <existing-checkpoint-path>` enrolls its exact saved session and captures its current idle report for supervisor review, without sending a new task. Save its worker ID; scopes remain paused. If it is already working, wait for a fresh settled report. For a new first task only, optional `/continuation-worker --start {"checkpoint":"/existing/checkpoint.md","message":"Initial user task"}` explicitly supplies that turn. Interrupted setup sends nothing; inspect before retrying. With `--start`, wait for the observed initial-run notice; if none arrives within 30 seconds, it is held—do not blindly resend. Later keyboard input to a registered worker creates a human-input hold.
2. Optionally, `/continuation-coordinator` in the intended existing coordinator; save its ID.
3. In the dedicated supervisor, `/continuation-supervisor init`, then `/continuation-supervisor add <worker-id> <workspace-id>`. New scopes start paused. `/continuation-supervisor coordinator <workspace-id> <coordinator-id>` pins the recipient, possibly in another workspace.
4. Confirm any other continuation owner has stopped. Explicitly confirm `/continuation-supervisor activate worker <id>`, `activate route <workspace-id>`, and `activate global`. One scope never lifts another. No experimental environment flag is required by the ordinary entry profile. `pause` has corresponding scoped forms; `status` reports scopes and pending work. `/continuation-worker-clear-hold` is a separate human-confirmed hold clear, not activation or approval for new work.

Registration rejects role collisions and duplicate canonical checkpoint paths. A changed checkpoint isolates its worker. Repeating setup preserves pauses; a coordinator cannot silently replace another. Explicit reactivation rearms unresolved attention once without resetting budget or replaying a delivered stop.

The model tool `continuation_disposition` resumes, acknowledges, pauses or queues one material notice per stop/kind. Resume/completion require pinned checkpoint evidence; material holds can cite the final reply or labeled blocked status evidence. Completion also requires the full checkpoint `reportHash` supplied with attention. No mandatory structured worker declarations replace narrative interpretation. Acknowledgement is not independent acceptance; a hash proves freshness, not meaning.

## Approval limits and acceptance

The existing workflow used Herdr state and model interpretation, not authoritative interception of every native/third-party dialog. This extension preserves that bounded contract and its existing observed prompt/input/error protections. Model misinterpretation, hidden/unreported UI and changes between process checks remain limitations—not solved guarantees. No silent bypass of a genuine approval, user pause or review requirement is permitted. See P3 in [the parity scenarios](docs/extension-parity.md).

Hold-recovery parity remains unresolved: current Clear hold discards even a fresh held report, leaving no eligible stop until a later turn. Changing that explicit old-stop invalidation contract is paused for the user's decision; this candidate is not complete parity. See [validation](docs/validation.md).

Source tests, historical synthetic narrative exercises and isolated package loads do not establish whole-workflow or user acceptance. No exhaustive native-UI proof is a hidden delivery prerequisite. Real-worker rehearsal, installation, migration, secrets and npm publication still require their own scoped instruction.

## Recovery and archival experiment

State lives in the private per-user `~/.pi-continuation` directory, not the source tree. Lost Herdr subscription pauses global continuation. Missing/older hold records and completed stops without a bounded final reply remain held. Older bindings without pinned checkpoints restart paused. Crash, `sending` intent or `accepted` receipt requires inspection; never delete observations/reset budgets to force a retry. Confirm a dead owner before manually reconciling stale owner artifacts; never remove a live lock/socket. Ownership handoff/rollback is described in [the contract](docs/contract.md#selected-worker-ownership-handoff-source-preparation).

The partial SDK/native-UI detour is preserved on [`experiment/sdk-host-native-ui-deferred`](https://github.com/fbl-vol/pi-continuation/tree/experiment/sdk-host-native-ui-deferred), explicitly **not accepted or part of ordinary package delivery**. Historical experimental source/tests remain in Git; the normal package ships neither its executable nor runtime/editor/trust resources. Their tests are historical regression evidence, not new parity requirements or a reason to expand native-UI work.

For an authorized disposable installation, `pi remove /absolute/path/to/pi-continuation` removes the package. This extension never autonomously installs packages, starts workers, migrates supervisors, changes timers or publishes npm.

MIT licensed. Planned npm name: `@fbl-vol/pi-continuation`; scope ownership/availability has not been verified for publication.
