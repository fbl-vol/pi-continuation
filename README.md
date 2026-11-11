# pi-continuation

Experimental, private Pi extension for explicitly registered Herdr-managed Pi TUI sessions. **Not released or installed into live Pi settings.** The personal GitHub repository is public; npm publication is disabled (`private: true`). Linux, macOS and native Windows are targets, **not verified support claims**. The contract and tested limits are in [docs/contract.md](docs/contract.md).

## What it does

- A worker registers its **current saved Pi session** and an existing checkpoint; observation begins paused. A fork or replacement session cannot inherit this binding. Pi's native Herdr integration still owns session and status reporting.
- A dedicated supervisor claims a local exclusive owner, checks Herdr's session/terminal/workspace/pane identity and persistent worker stops, and can dispose of each stop through a model tool. Registration and activation at global, route, and worker levels are separate TUI-confirmed actions. Model tools cannot activate scopes.
- Continuation is delivered to a worker-owned local socket, not through `agent.prompt`. The worker checks its own native session, exact stop, idle state, active owner and all pauses before injecting a Pi custom message. An uncertain delivery pauses that worker; old receipts cannot be retried. Escape, tool errors and UI approval prompts produce sticky holds requiring explicit human clearing.
- Two nudges without new checkpoint evidence pause only the affected worker. Unresolved supervisor turns get one corrective wake, then a worker-local pause. Material completion/blocker/decision notices can be queued for a registered exact coordinator session; busy, blocked or replaced recipients remain deferred and stale completion is discarded. No coordinator receives approval authority.

These mechanisms have **only isolated local tests** so far. The packed artifact was loaded by an isolated, in-memory Pi 1.5.0 SDK session on Linux without credentialed model calls or real Herdr workers. Disposable credentialed Pi/Herdr runtime behavior and macOS/Windows execution are not verified. A prose-only approval request that never triggers a UI prompt or an explicit worker signal cannot be treated as a guaranteed hold. Do not connect this package to existing workers or rely on it to replace existing supervision on the strength of this repository alone.

## Development / dry-run setup

Run `npm ci --legacy-peer-deps`, `npm test`, and `npm pack --dry-run`. Tests use fake Pi contexts, fake Herdr sockets, local loopback sockets, temporary files and competing child processes; they do not touch real workers. CI schedules isolated tests and payload checks on Linux, macOS, and Windows, but a scheduled check is not a passed platform result. Pi 1.5.0 and Herdr 0.9.5 (protocol 22) are the current development baseline, not a verified cross-platform support matrix. The package has one explicitly listed extension entrypoint and an explicit npm file allowlist; tests, local plans and checkpoint files are excluded.

For a **separately authorized disposable** installation only, Pi accepts a local package with `pi install /absolute/path/to/pi-continuation` (this changes Pi settings). The intended TUI command sequence is:

1. In each existing worker, `/continuation-worker <existing-checkpoint-path>`; save its displayed worker ID. A registration is observation-only and paused.
2. In an existing coordinator if desired, `/continuation-coordinator`; save its displayed coordinator ID.
3. In the dedicated supervisor, `/continuation-supervisor init`, then `/continuation-supervisor add <worker-id> <workspace-id>`. The worker's Herdr native Pi session, terminal, pane, cwd and workspace must match; new routes start paused. `/continuation-supervisor coordinator <workspace-id> <coordinator-id>` binds an exact recipient.
4. Confirm any old continuation owner has **stopped** before activating a worker. Explicitly `/continuation-supervisor activate worker <id>`, `activate route <workspace-id>`, and `activate global`. One scope never lifts another. `/continuation-supervisor status` reports current scopes and pending disposition; `pause` has corresponding scoped forms. `/continuation-worker-clear-hold` is a human-confirmed worker hold clear, not a scope activation.

The supervisor model uses `continuation_disposition` to resume, acknowledge, pause, or issue one material notice per stop/kind, with evidence taken from the worker checkpoint. An acknowledgement does not independently accept the assignment. Do not paste instructions disguised as model tool calls into the command line; activation is a TUI-confirmed human command only.

## Recovery and removal

State lives in a private per-user `~/.pi-continuation` directory; no state is written into this source tree. A lost Herdr subscription pauses the global scope. Crash or uncertain receipt **never** triggers blind retransmission. A new supervisor process cannot take an existing owner claim automatically: after confirming the previous process is gone, inspect its lock/socket and pending intents, then remove stale owner artifacts under the private state directory before explicitly initializing a new supervisor. Treat `sending` intents and `accepted` receipts as uncertain and pause the affected worker. Do not delete worker observations or reset budgets to make a retry work. The Unix socket pathname is removed on orderly shutdown; Windows uses named pipes. Never remove a live owner's lock or socket.

For an authorized disposable Pi installation, remove the package using `pi remove /absolute/path/to/pi-continuation` and stop the disposable sessions before cleaning state. This package never starts workers, migrates old supervisors, changes OS timers, installs Herdr integrations, or publishes npm. Publication, live installation, real worker registration, migration and platform/runtime verification require separate explicit authority.

MIT licensed. Planned npm name: `@fbl-vol/pi-continuation`; ownership and availability of that scope have not been verified for publication.
