# pi-continuation

An experimental **ordinary Pi extension** for explicitly registered Herdr-managed Pi TUI sessions. Load it through normal Pi package/extension startup; no SDK launcher, first-command-line-option rule or Pi fork is required. Installation alone registers and activates nothing.

**Current release: `v0.3.1`, for controlled trials—not general replacement readiness.** Distributed through [GitHub releases](https://github.com/fbl-vol/pi-continuation/releases/tag/v0.3.1); npm publication remains disabled (`private: true`). The start workflow has no real-model acceptance yet; earlier focused Linux Pi 1.5.2/Herdr 0.9.5 trials exercised the advanced workflow. The known same-decision reassessment limitation remains. Native Windows and macOS runtime support is not verified; macOS validation is deferred. Existing-worker migration is not included. [The bounded parity scenarios](docs/extension-parity.md) define the outcome; [the contract](docs/contract.md) and [validation](docs/validation.md) describe protections and limits.

## What it does

- Pins a worker's current saved Pi session, checkpoint, terminal, pane, cwd and workspace. A replacement/fork never silently inherits registration.
- Uses Pi lifecycle/persistence/messaging and Herdr's existing identity/status reporting. The dedicated supervisor interprets the final reply and checkpoint against the **whole assignment**, including follow-ups. A favorable review alone is not completion; interpretation never grants new authority.
- Gives blocked workers attention even mid-turn, before an assistant stop exists. Herdr status evidence is explicitly labeled, not a fabricated worker reply or resumable native stop. Blocked/held workers cannot be resumed or declared complete. Genuine approval requests require a decision/pause, not invented approval.
- Keeps human-confirmed global, route and worker control. Only the scoped delegation path can enroll its newly created worker without per-worker confirmation; model tools cannot otherwise activate scopes or clear user holds. Escape, tool errors and observed shared-UI prompts create sticky holds. In the start workflow, ordinary submitted tasks release only their provisional typing fence; alpha.1/advanced registration retains its existing sticky keyboard hold.
- Delivers through a worker-owned local receiver, not `agent.prompt`. A final Herdr identity/status/sequence check precedes addressed delivery; the receiver rechecks exact native stop, session, owner, hold and pauses. One-use receipts prevent replay. Uncertain delivery pauses for inspection, not retry.
- Bounds unchanged progress at two nudges and unresolved supervisor attention at one corrective wake before worker-local escalation. Material completion/blocker/decision notices go only to an exact coordinator; definite deferral stays pending, uncertainty pauses, stale completion is discarded.
- Retains selected-worker ownership fencing and paused handoff/rollback history. Source preparation is not authorization to install an adapter or migrate live supervision.

## Install v0.3.1

Start with a disposable Pi profile and disposable Herdr sessions. The installed Herdr Pi integration must report saved session identity and state. Earlier advanced-workflow trials used Linux with Pi 1.5.2 and Herdr 0.9.5 (protocol 22); alpha.2's downloaded package was discovered and bound with Pi 1.5.0 and 1.5.2 without a model request.

```sh
pi install git:github.com/fbl-vol/pi-continuation@v0.3.1
```

Installation changes that profile's Pi settings; restart or reload the intended Pi session afterward. To upgrade an existing pinned installation, run the same install command with the new tag; `pi update --extensions` alone does not advance a pinned tag. Other running sessions keep their loaded code until individually restarted or reloaded. It does **not** register workers, activate scopes or replace an existing continuation owner. Use the explicit setup below. Do not run two continuation owners over the same worker or migrate an existing worker without a separately planned pilot.

To remove this package from the same profile:

```sh
pi remove git:github.com/fbl-vol/pi-continuation@v0.3.1
```

Removal does not delete retained continuation state or session history. Release tarballs are also available as GitHub assets. See [the changelog](CHANGELOG.md).

## Two-command workflow (since alpha.2)

After a separately authorized installation:

1. In the intended supervisor, `/continuation-supervisor start` and confirm.
2. In each selected worker, `/continuation-worker start` and confirm that it has no other continuation owner.

**Blank-session start:** current source permits a fresh blank worker to join before Pi creates its journal. It sends no task and leaves journal creation to native Pi; continuation still requires a persisted session. Published alpha.2 lacks this fix: for that version, send a harmless ordinary message and let it finish before worker start.

**Pane-reuse recovery:** if this pane previously hosted another registered
session, current source offers a separate **retire old registration and start this
session** confirmation. It retains old history and registers a fresh worker, never
inherits approvals or silently follows a replacement. A still-live old session,
pending/uncertain delivery or unverifiable ownership blocks replacement. Cancelling
keeps the old registration and holds the new worker. Independent scope pauses stay
paused. Published alpha.2 lacks this workflow.

Then send ordinary tasks normally. Fresh registrations get an automatically maintained private checkpoint from native projected user/assistant text and compaction summaries—not system prompts, tool payloads, thinking or image bytes. No copied IDs, checkpoint declarations or separate scope activation are needed. Visible workers are never auto-enrolled; missing/conflicting ownership is refused. Existing manually pinned checkpoints remain manual and are not replaced.

Escape/interruption, observed external prompts and errors still stop continuation. After resolving the reason, repeat worker `start` to return control. Start never answers an unresolved approval or resets budgets/receipts. It enables that worker and a new route only; independently paused existing global/route scopes stay paused. Supervisor `start` explicitly enables its global scope while preserving worker/route pauses. Advanced scoped controls below remain available. This source workflow has isolated contract/native-API tests, not a new real-model or platform acceptance claim.

## Session management (since v0.3.0)

Use `/continuation` in a Herdr-managed Pi session to see its supervision status and
known supervised workers. Native menus show session labels and status; exact IDs
and checkpoint paths are available in Details rather than needed for normal use.
An unsupervised planning session can inspect or pause a selected exact worker.
Existing advanced commands remain available.

**Since v0.3.1:** the menu prefers your Herdr pane labels
and shows exact current bindings under **Current workers**. Closed/replaced
registrations are kept behind **Previous / unavailable registrations (N)** with
`Pane closed` or `Session changed` explanations and read-only Details. Missing
observations stay visibly unknown in Current workers, not hidden as old history.
Browsing never deletes registrations, resets history or activates scopes. Published
v0.3.0 uses the earlier flat list.

- **Pause** changes only the selected worker and leaves it listed. Global controls
  are available in the actual supervisor; their confirmations remain explicit.
- **Stop supervising** withdraws the exact worker from the active list but retains
  its identity, checkpoint, history, spent budgets, handled stops and receipts.
  It refuses unresolved continuation, notices or delegated startup. This is not
  permanent retirement and never terminates the Pi session.
- **Return** is available only in that worker's own session, through the menu or
  `/continuation-worker start`. It requires fresh explicit confirmation after Stop,
  not an old in-flight start. A pause that predated Stop remains paused on return,
  as do independent global/workspace pauses. Normal explicit worker activation
  remains a separate action when such a pause needs lifting.

Return does not answer approvals, select review findings, reset budgets or replay
consumed/uncertain effects. Resolve the actual hold before returning. Changed
session/owner identity or ambiguous control delivery requires inspection, not
automatic retry. Installation alone still registers and activates nothing.

Current source also reports compact, expiring supervision labels in Herdr's
existing Agents/Spaces views. Native activity stays separate; badges never grant
permission. See the [one-time optional sidebar setup](docs/herdr-annotations.md).
No live configuration is rewritten and no extra plugin is required.

## Supervised delegation (since v0.3.0)

For an already installed ordinary extension and an **already-running intended
supervisor**, the planning session need not enroll in continuation:

1. In the planning session, authorize the assignment once with
   `/continuation-delegate writer <bounded assignment scope>` (or `read-only`) and confirm that scope.
2. The agent calls `continuation_spawn` with a stable `key`, `task`, and `role`
   (`writer` or `read-only`). It creates a new unfocused Herdr pane, starts normal
   Pi, verifies native identity, enrolls with that exact supervisor, and only then
   sends the task. No worker enrollment command or per-worker confirmation.
3. New workers inherit the same scoped delegation authority. Read-only children
   cannot create writers. A writer may delegate read-only work, not a second writer
   against the same checkout. The planning parent must stop editing before handing
   implementation to a writer.

The grant pins the displayed supervisor session, cwd, scope and role ceiling.
Writer grants require Git on PATH and pin the checkout's Git common directory;
subdirectories cannot acquire separate writer claims for that same checkout.
The native scope grant is deliberate authorization, not automatic interpretation
of brainstorming or a model-controlled activation flag. Normal startup must load
this extension in the child profile/project; no installation/settings/SDK launcher
is performed. Missing loading or changed supervisor identity holds the attempt.
Global, route and parent-worker pauses/holds remain independent and are not lifted.
`/continuation-delegate revoke` in the originating planning session stops further
delegation for the tree; existing worker supervision is unchanged. Revoke the
current tree before authorizing a different scope in that same planning session.

Keep the same key for an assignment. Duplicate keys/exact tasks are refused;
uncertain effects and writer claims remain retained for inspection, never retried
or automatically released. Do not change keys or delete private claims to force
another spawn. Scope membership and read-only behavior still require cooperating
agents; this is not a filesystem sandbox. Delegation grants no new secrets,
deployment/publication authority or acceptance. Awaiting **user selection of review
findings** is a decision pause, not permission to resume and apply fixes.

Only isolated fake Pi/Herdr and temporary-state tests have exercised this path.
No live delegated-worker or native Windows/macOS runtime acceptance is claimed.
The [approved amendment and P1–P7 scenarios](docs/extension-parity.md) define its
bounded protections and recovery limits.

## Development and disposable use

Run `npm ci --legacy-peer-deps`, `npm test`, and `npm run check:package`. Tests use fake sessions/transports, temporary state, loopback sockets and competing child processes—not real workers. The explicit package allowlist excludes tests, private records and experimental SDK launcher/resources. Pi 1.5.0 and Herdr protocol 22 are the development baseline, not a cross-platform certification.

Only for a **separately authorized disposable** environment, `pi install /absolute/path/to/pi-continuation` installs the normal package (and changes Pi settings). Start/reload Pi through its ordinary loading mechanism; no special launcher or first `-e` ordering is required. For the released alpha.1 or advanced explicit setup, the command sequence is:

1. In an existing worker, `/continuation-worker <existing-checkpoint-path>` enrolls its exact saved session and captures its current idle report for supervisor review, without sending a new task. Save its worker ID; scopes remain paused. If it is already working, wait for a fresh settled report. For a new first task only, optional `/continuation-worker --start {"checkpoint":"/existing/checkpoint.md","message":"Initial user task"}` explicitly supplies that turn. Interrupted setup sends nothing; inspect before retrying. With `--start`, wait for the observed initial-run notice; if none arrives within 30 seconds, it is held—do not blindly resend. Later keyboard input to a registered worker creates a human-input hold.
2. Optionally, `/continuation-coordinator` in the intended existing coordinator; save its ID.
3. In the dedicated supervisor, `/continuation-supervisor init`, then `/continuation-supervisor add <worker-id> <workspace-id>`. New scopes start paused. `/continuation-supervisor coordinator <workspace-id> <coordinator-id>` pins the recipient, possibly in another workspace.
4. Confirm any other continuation owner has stopped. Explicitly confirm `/continuation-supervisor activate worker <id>`, `activate route <workspace-id>`, and `activate global`. One scope never lifts another. No experimental environment flag is required by the ordinary entry profile. `pause` has corresponding scoped forms; `status` reports scopes and pending work. `/continuation-worker-clear-hold` is a separate human-confirmed hold clear after resolving the reason. It may make the current unchanged held report available for supervisor reassessment; it is not action approval or activation and does not lift other pauses or reset budgets.

Registration rejects role collisions and duplicate canonical checkpoint paths. A changed checkpoint isolates its worker. Repeating setup preserves pauses; a coordinator cannot silently replace another. Explicit reactivation rearms unresolved attention once without resetting budget or replaying a delivered stop.

Supervisor attention carries current hold state and whether an exact coordinator is bound. It distinguishes a temporary held-action rejection from a stale report or an already handled/delivered action: fresh eligible attention can request reassessment of the same unchanged stop after human Clear, never blind retry or new authority. For whole-assignment completion, guidance requests one completion notice when a coordinator is bound, otherwise acknowledgement. This is model guidance, not a guarantee against misinterpretation.

The model tool `continuation_disposition` resumes, acknowledges, pauses or queues one material notice per stop/kind. Resume/completion require pinned checkpoint evidence; material holds can cite the final reply or labeled blocked status evidence. Completion also requires the full checkpoint `reportHash` supplied with attention. No mandatory structured worker declarations replace narrative interpretation. Acknowledgement is not independent acceptance; a hash proves freshness, not meaning.

## Approval limits and acceptance

The existing workflow used Herdr state and model interpretation, not authoritative interception of every native/third-party dialog. This extension preserves that bounded contract and its existing observed prompt/input/error protections. Model misinterpretation, hidden/unreported UI and changes between process checks remain limitations—not solved guarantees. No silent bypass of a genuine approval, user pause or review requirement is permitted. See P3 in [the parity scenarios](docs/extension-parity.md).

Clear hold preserves the same nonce only for a current unchanged successful held report. The start input mode can also park an unchanged idle report during typing/Escape and recover that same nonce on explicit return. Stale, missing and aborted/error reports are not rearmed; attempted/delivered/ambiguous work remains subject to existing no-replay guards. The supervisor must still interpret the report and cannot infer action approval from Clear. Source checks are not personal workflow acceptance; see [validation](docs/validation.md).

Source tests, synthetic narrative exercises, isolated package loads and a focused controlled real-model trial do not establish general reliability, whole-workflow or user acceptance. No exhaustive native-UI proof is a hidden delivery prerequisite. Real-worker rehearsal, installation, migration, secrets and npm publication still require their own scoped instruction.

## Recovery and archival experiment

State lives in the private per-user `~/.pi-continuation` directory, not the source tree. Lost Herdr subscription pauses global continuation. Missing/older hold records and completed stops without a bounded final reply remain held. Older bindings without pinned checkpoints restart paused. Crash, `sending` intent or `accepted` receipt requires inspection; never delete observations/reset budgets to force a retry. Confirm a dead owner before manually reconciling stale owner artifacts; never remove a live lock/socket. Ownership handoff/rollback is described in [the contract](docs/contract.md#selected-worker-ownership-handoff-source-preparation).

The partial SDK/native-UI detour is preserved on [`experiment/sdk-host-native-ui-deferred`](https://github.com/fbl-vol/pi-continuation/tree/experiment/sdk-host-native-ui-deferred), explicitly **not accepted or part of ordinary package delivery**. Historical experimental source/tests remain in Git; the normal package ships neither its executable nor runtime/editor/trust resources. Their tests are historical regression evidence, not new parity requirements or a reason to expand native-UI work.

For an authorized disposable installation, `pi remove /absolute/path/to/pi-continuation` removes the package. This extension never autonomously installs packages, creates/replaces supervisors, migrates supervision, changes timers or publishes npm. Worker creation is limited to the explicitly scoped delegated path described above.

MIT licensed. Package name: `@fbl-vol/pi-continuation`. This alpha is available from GitHub, not npm.
