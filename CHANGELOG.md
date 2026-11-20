# Changelog

## [0.6.0] - 2026-11-20

- Start or reuse a dedicated supervisor during `/start-implementation`; resume
  an ordinary global pause without clearing independent pauses or holds.
- Choose worktree and Herdr space in one step, and retry a proved pre-effect
  refusal with the same command after correcting the prerequisite.
- Recover an unchanged managed worker report after a verified checkpoint rewrite.
- Configure delivery preferences in `/continuation`, including per-assignment
  overrides. Human finding selection and Git permissions still apply.
- Uncertain starts or deliveries are not retried; one-answer owner decision
  release and automatic writer-slot closeout are not implemented.

## [0.5.0] - 2026-11-20

- Select the assignment's named or absolute local checkout independently of the
  planning pane's cwd. Bare launch uses the agreed assignment for selection while
  retaining earlier constraints in the owner's task; ambiguous targets prompt
  once and unverifiable paths refuse before launch.
- Fence writers per canonical working tree, including alternate paths and Herdr
  spaces. When an exact live writer occupies a tree, an explicitly confirmed new
  linked worktree uses its own branch and path without retrying uncertain effects.
  Retained Git-common-directory claims remain checked against their original tree.
- Add disposable Linux Pi/Herdr nested-checkout launch verification and isolated
  linked-worktree/ownership tests. No live or native Windows/macOS runtime
  acceptance, automatic session reload, or migration is implied by installation.

## [0.4.6] - 2026-11-20

- Show readable role labels in newly delegated Herdr panes and the Agents
  sidebar, without renaming existing panes or changing supervision status.
- Let `/start-implementation` proceed past verified inactive historical
  registrations and safely archive provably undelivered orphaned blocker notices
  in the same invocation. Live writers, ambiguous state and unresolved effects
  still block. Legacy pending notices without no-send evidence still block, and
  existing held launch attempts are not retried.
- Older versions cannot read the new supervisor state schema. Update participating
  sessions together before using the new behavior; a package downgrade alone
  does not roll back persisted state.

## [0.4.5] - 2026-11-19

- Wait for the delegated pane's foreground shell on Linux and macOS before
  sending a single Pi start request. Recheck pane identity before starting Pi.
- Exercise a delayed Bash startup in the native Linux Herdr/Pi smoke test,
  both before pushing and in CI. Existing held attempts are unchanged.

## [0.4.4] - 2026-11-19

- Generate Herdr-compatible agent names and wait for interactive Pi readiness
  before enrollment without repeating a start request.
- Run a real Herdr/Pi startup smoke test on Linux pre-push and in Linux CI,
  with temporary state and a scripted loopback model.
- A very fast reply can still pause the new owner. The smoke test verifies
  startup and assignment delivery, not that race or the full live workflow.

## [0.4.3] - 2026-11-19

- Accept Herdr 0.9.5's `pane_info` response after splitting a pane so delegated
  startup can proceed to Pi instead of stopping at a newly opened shell.
- Existing held attempts and checkout fences are unchanged. The fix has isolated
  regression coverage; it has not been verified in a live owner launch.

## [0.4.2] - 2026-11-19

- Run bare `/start-implementation` to hand off the agreed plan from the current
  conversation without another command or confirmation. The handoff preserves
  the latest user agreement and cited earlier constraints. Explicit scope remains
  supported; unclear plans do not launch an owner.
- Verified closed, paused worker records no longer block fresh launches by
  themselves. History, retained writer claims, and unresolved deliveries still
  receive their existing protections.

This GitHub release is for controlled trials. Real-model plan selection and the
full live workflow have not yet been verified.

## [0.4.1] - 2026-11-19

- Start a fresh supervised coordinating owner with `/start-implementation <agreed
  assignment>` from an unsupervised Herdr Pi session. The command replaces the
  three manual owner setup steps, not approvals for later decisions.
- Retain uncertain owner launches and block another attempt for the same Git
  checkout, even if the wording or originating session changes.
- Await corrective-wake state writes so the restart check can verify lock
  release without polling the persisted state. Use the same checks locally
  through the opt-in pre-push hook and in CI.

This GitHub release is for controlled trials. The full live owner workflow
has not yet been verified.

## [0.4.0] - 2026-11-19

GitHub minor release for controlled trials; npm publication remains disabled.

- Add a supervised coordinating owner who receives material notices from its
  own delegated workers and reviewers. Routing follows the exact assignment
  owner, not the Herdr workspace. The brainstorming session can stay unsupervised.
- Distinguish waiting for named children from waiting for a user decision.
  Child notices defer during a user wait; release requires confirmation in the
  owner session and the user supplies their decision in an ordinary message.
- Keep one implementation writer per checkout and preserve independent review,
  scoped pauses, exact evidence checks, and delivery history. Installation alone
  does not enroll sessions, clear holds, or migrate existing supervision.
- Isolated tests cover the owner flow; live end-to-end operation is not yet verified.

## [0.3.3] - 2026-11-18

GitHub patch release for controlled trials; npm publication remains disabled.
Update the pinned Git tag and restart intended sessions to load the new behavior.
Installation does not clear existing holds or migrate supervision.

- Intermediate tool failures no longer latch permanent continuation holds during
  ordinary runs. Failed settled turns, observed approval/interruption guards,
  checkpoint failures, provisional-setup fencing and delivery safeguards remain.
- New run/checkpoint error holds have cause-specific labels and Details with the
  hold-recorded time and confirmed recovery path. Existing unclassified error
  holds stay held; no raw tool/provider payloads or automatic recovery are added.
- Validate with 306 isolated tests and the unchanged explicit 32-file payload.
  Independent source review and selected-fix re-review are complete; source CI
  passes Linux, Windows and macOS. Synthetic native Linux rendering/component
  checks are not real-worker, real-model or native cross-platform acceptance.

## [0.3.2] - 2026-11-18

GitHub patch release for controlled trials; npm publication remains disabled.
Update the pinned Git tag and reload intended sessions to use the corrected commands.
Installation does not repair existing invalid registrations or migrate supervision.

- Make bare `/continuation-worker` an alias for the existing human-confirmed `start` workflow; retain explicit checkpoint and `--start` advanced registration.
- Reject directory/non-file checkpoints before advanced registration can persist an invalid worker. Existing registrations and live supervision are not migrated or rewritten.
- Treat Herdr's explicit missing-pane/workspace response as benign only when clearing display tokens after a target disappears. Preserve structured Herdr error codes, keep publication and other cleanup failures visible, and leave supervision authority unchanged.
- Validate with 294 isolated tests and the unchanged explicit 32-file package payload. Independent source review found no material findings; source CI passes Linux, Windows and macOS. No new real-worker, real-model or native platform runtime acceptance is claimed.

## [0.3.1] - 2026-11-17

GitHub patch release for controlled trials; npm publication remains disabled.
Update the pinned Git tag and reload only intended Pi sessions to use it.
Installation does not enroll workers or migrate supervision.

- Prefer Herdr pane labels in `/continuation`. Show exact current worker bindings separately from retained previous/unavailable registrations, distinguish Pane closed from Session changed, and keep previous entries inspectable without control actions or history deletion. Unknown observations remain visible among current workers.
- Validate with 287 isolated tests and the unchanged explicit 32-file payload. Focused native Linux Pi 1.5.2 keyboard checks with isolated profiles and fake Herdr cover labels, history/Details and Pause → Stop → Return with pauses/history retained and zero model requests. This is not live Herdr, real-model or native Windows/macOS acceptance; existing limitations remain.

## [0.3.0] - 2026-11-17

GitHub feature release; npm publication remains disabled. Existing installations
must update their pinned Git tag and reload the intended Pi session. Installation
does not enroll workers or migrate supervision.

- Add `/continuation`: readable session status, worker selection, Details and exact-worker Pause/Stop controls. Retained Stop preserves history, budgets and receipts; Return requires fresh confirmation in the worker's own session and preserves independent pauses.
- Add display-only, expiring supervision badges and workspace counts in Herdr's existing Agents/Spaces views. Optional sidebar rows require the separate one-time setup in `docs/herdr-annotations.md`; installation never rewrites Herdr configuration. Missing native owner verification suppresses annotations, not continuation authority.
- Add explicitly scoped `/continuation-delegate` and `continuation_spawn` for new workers through ordinary Pi startup, with exact supervisor enrollment before task dispatch, role ceilings, checkout writer exclusion and retained duplicate/uncertainty guards.
- Validate the integrated source with 283 isolated tests and a 32-file explicit package payload. Linux/Windows/macOS source CI is not native runtime or real-model acceptance. Known model reassessment and platform limitations remain.

- Let worker `start` offer explicit retirement of an older session registered in the same pane. Preserve the old binding/history, recheck ownership and pending delivery, and join the new session as a fresh worker without lifting other scope pauses. Never silently follow replacements or retry ambiguous effects.
- Explain live-session, pending-delivery, retired-session and registration conflicts instead of hiding them behind `UNEXPECTED`.

- Fix fresh blank-worker start before Pi has created its session journal. Pin the future canonical path for enrollment only; delivery still requires persistence, and existing ownership witnesses remain enforced. No synthetic task or native journal write is used.
- Classify ownership refusals as `OWNERSHIP_FENCE` rather than hiding them behind `UNEXPECTED`.
- Correct the start fixture's premature journal creation and check the blank-to-first-task lifecycle and ownership refusals. Native Pi 1.5.0/1.5.2 temporary-session probes pass; no live installation or worker changes are implied.

## [0.2.1] - 2026-11-16

- Correct package and lockfile versions to match the immutable `v0.2.1` Git tag. That tag did not have a separate GitHub release entry.

## [0.2.0] - 2026-11-16

- Historical GitHub release of the start workflow with a blank-session correction. Its package metadata still reported `0.1.0-alpha.2`; the tag is retained unchanged. The matching-version correction followed in `v0.2.1`.

## [0.1.0-alpha.2] - 2026-11-16

GitHub prerelease packaging the merged start workflow for controlled trials;
npm publication remains disabled.

- Add human-confirmed `/continuation-supervisor start` and `/continuation-worker start`: automatic exact-session joining, routing, fresh-worker checkpoint bookkeeping and bounded activation, without copying IDs or sending a task.
- Keep ordinary submitted tasks supervised after opt-in, while preserving sticky interruptions/prompts/errors, pending decisions, independent scope pauses, budgets, receipts and same-stop no-replay history. Advanced explicit setup remains available.
- Validate with 204 isolated tests, native Pi 1.5.0/1.5.2 projection/loading probes and a 27-file explicit payload. No new release, live installation, worker migration or platform runtime acceptance is implied; the observed model reassessment limitation remains documented.

## [0.1.0-alpha.1] - 2026-11-13

First GitHub alpha prerelease of the ordinary Pi continuation extension.

### Included

- Explicit saved-session worker and coordinator registration in Herdr, with a dedicated continuation supervisor.
- Independent human-confirmed activation and pauses for global, route and worker scopes; installation alone activates nothing.
- Narrative interpretation of the whole assignment, including remaining work and genuine user decisions.
- Exact-stop native delivery, one-use receipts, duplicate suppression, bounded nudges and material coordinator notices.
- Sticky holds and bounded same-report reassessment after explicit human Clear, without granting approval or resetting pauses, budgets or delivery history.
- Herdr `idle` and `done` settled-state compatibility, specific refusal reasons and completion-notice guidance for bound coordinators.

### Validation and limits

- 188 isolated tests pass; the package has an explicit payload excluding private records, tests and experimental SDK launcher/resources.
- A focused Linux Pi 1.5.2/Herdr 0.9.5 real-model trial passed held-report reassessment, single completion delivery and an undelegated user-choice stop without mid-trial supervisor coaching.
- One controlled pass is not a general model-reliability guarantee, exhaustive native/third-party UI interception or acceptance for existing workers.
- Native Windows runtime is not verified. macOS validation is deferred. Linux/Windows source CI is not cross-platform runtime acceptance.
- No required SDK launcher, Pi fork or new upstream API. No automatic worker migration or supervision-service installation.
- GitHub distribution only; npm publication remains disabled. See the README for the pinned Git-tag installation path and the contract for recovery limitations.
