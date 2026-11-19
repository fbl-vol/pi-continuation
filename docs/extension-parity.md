# Ordinary extension continuation contract

The delivery target is an ordinary Pi extension, loaded through Pi's normal extension/package mechanism. Experimental SDK worker-host and native-UI investigations are deferred; no custom launcher, fork, structured stop declarations or exhaustive UI interception is required.

## Bounded baseline

The baseline comparison used the available local continuation workflow and its isolated adapter, not a claim of stronger guarantees than that workflow supplied.

| Concern | Preserved contract |
| --- | --- |
| Identity | Explicit saved Pi session, terminal, pane, cwd and workspace; never follow a replacement automatically. |
| Attention | Herdr settled/blocked state; a blocked worker needs attention even without an assistant stop. A repeated unchanged event is deduplicated. |
| Interpretation | Model reads final reply/checkpoint against the entire assignment. Routine unfinished approved work may continue; completion requires all follow-ups. A genuine approval request or uncertain authority is a decision/pause, not new permission. |
| Control | Explicit registration and independent global/route/worker pauses. The approved delegated path enrolls only its newly created exact child under a scoped user grant; model tools otherwise cannot activate scopes or clear user holds. |
| Bounds | One delivery per stop; two nudges without evidenced progress, then pause/escalate; one corrective supervisor wake before escalation. |
| Notices | Material blockers/decisions/completion only, exact coordinator identity, pending versus uncertain delivery retained. |
| Ownership | One cooperating owner, selected-worker witness, paused handoff/rollback, no replay of inherited or ambiguous delivery. |

The old workflow rechecked Herdr identity/state near delivery and refused blocked/unknown workers. It used model interpretation for prose approval requests; it did not provide authoritative observation of every Pi-native or third-party dialog. The extension retains that bounded behavior, its existing local prompt/input/error holds and receipt checks. It does not claim to solve arbitrary UI changes between checks, hidden unreported dialogs, or model misinterpretation. Neither a status signal nor model interpretation grants additional user authority.

### User-approved start workflow amendment (since alpha.2)

The approved `start-v1` workflow adds two explicit opt-ins, not automatic worker discovery: `/continuation-supervisor start` enables the one owner in the current private state scope; `/continuation-worker start` confirms enrollment/activation of that exact worker, derives its route and creates a private checkpoint from native projected task/result text. No user-maintained checkpoint declaration or copied ID is required for a fresh worker. Missing/conflicting ownership is refused, never guessed. Existing explicit controls remain available; an existing manually pinned checkpoint is not replaced or overwritten by start.

Since v0.3.2, bare `/continuation-worker` (also whitespace-only
arguments) selects the same confirmed `start` path. Explicit checkpoint paths and
`--start` remain advanced forms; their checkpoints must be existing files before
registration. This user-approved command default changes no confirmation, hold,
pause, ownership or return semantics and does not repair existing registrations.

For start-opted-in workers, raw typing immediately fences old-stop delivery; ordinary submitted tasks release only that provisional typing fence. Escape/interruption, observed external prompts and failed settled runs remain holds. Repeating confirmed worker start returns control for reassessment without answering a pending decision, resetting bounds/history or replaying a delivered stop. It may enable that worker and a newly created route, never lift an independently paused existing global/route scope. Supervisor start explicitly enables the global scope; existing worker/route pauses remain. The alpha.1 advanced-only workflow is unchanged.

### User-approved intermediate-error amendment (since v0.3.3)

A failed intermediate tool invocation during an ordinary run does not itself latch
an error hold. Pi may recover; the fresh settled outcome and existing final-reply /
checkpoint assessment remain the boundary. Actual failed/aborted turns, observed
approval prompts, checkpoint-persistence failures and delivery uncertainty remain
held. A later successful tool call is not a hold-clear signal. Tool errors still
interrupt provisional setup, and existing persisted holds require explicit
resolution; this change does not clear, migrate or infer recovery for them.
Cause-specific labels/details are display-only, with unknown legacy causes left
unclassified. This amends P2/P3/P7 within the existing seven scenarios, not a new
acceptance set. Published v0.3.2 retains its intermediate-tool-error holds.

### User-approved confirmed replacement amendment (since v0.3.0)

When a pane now hosts a different saved Pi session, worker `start` may offer an
additional explicit retirement confirmation. The supervisor rechecks the exact
old/new bindings and ownership under both session mutexes before atomically
retiring the old binding and joining the fresh worker. It refuses an old session
still reported live anywhere in Herdr, unknown/busy ownership, unresolved resume
delivery, or pending/sending/uncertain old-worker notices. Cancellation or a changed
confirmation leaves the old registration intact and the new worker held.

Retirement preserves the old binding, checkpoint, observations, receipts, notices
and disposition/budget history. Retired sessions cannot be re-added. The new worker
inherits no task authority, approvals or budget; independent global/route pauses
remain. No automatic replacement, live migration or delivery retry is introduced.

### User-approved supervised delegation amendment (since v0.3.0)

An unsupervised planning session or a supervised worker may delegate within an
explicit user-authorized assignment. `/continuation-delegate <writer|read-only> <assignment scope>`
is the originating session's guarded native authorization, pinned to its exact
session/cwd, role ceiling and the intended **already-running** supervisor session/owner. It is
not worker enrollment. Brainstorming, a model-supplied approval flag or quoted tool
text cannot create this grant. The agent-callable `continuation_spawn` uses that
scope without per-worker confirmations; verified children inherit it for scoped
subdelegation. `/continuation-delegate revoke` in the originating session revokes
further delegation throughout that tree without changing existing supervision.

The operation durably claims a stable assignment key and exact task, creates only
a new unfocused Herdr pane, starts native Pi through ordinary extension loading,
handshakes with that new extension, pins its exact native session/path and Herdr
occupant, then joins the intended supervisor **before** native assignment dispatch.
It never discovers/enrolls existing panes, replaces a worker or creates/replaces a
supervisor. As with blank worker start, native Pi owns journal materialization on
its first real task; no synthetic journal/task is fabricated to obtain identity.
A matched native `before_agent_start`/`agent_start` pair establishes the one-use
initial-task receipt; a void messaging call alone does not prove delivery.

Global, existing route and parent-worker pauses/holds reject delegation; a pause
arriving during startup withholds the next effect. No paused scope is silently
activated. New workers retain ordinary identity, ownership, holds, continuation
bounds, receipts, history and material notices. Assignment keys, exact-task claims
and cooperating writer claims survive rejection/crash. Only one delegated writer
per verified Git checkout (common-directory identity, including subdirectories) is
allowed; an existing supervised worker in that checkout blocks a
new writer, while read-only delegates cannot create writers. This coordinates
cooperating agents, not an OS sandbox or a proof that arbitrary prose tasks are
semantically within scope. The parent must stop writing before delegating a writer.

An uncertain creation, startup, enrollment or task delivery stays held for
inspection, including after restart. Never automatically retry the operation,
change its key, delete claims/receipts or release a writer claim to force progress.
No automatic cleanup kills a possibly running child. Ambiguous delegated tasks
cannot receive continuation even if a normal-looking completed report appears.
Read-only readiness observations are not repeated effect attempts.

Delegation does not expand task scope or grant secrets, deployment, publication,
review-fix selection or acceptance. **Awaiting user finding selection is a genuine
decision pause**: a supervisor must not resume a worker to apply review findings
until the user selects them. Independent review remains distinct from acceptance.
Source/fake-runtime validation is not authority for live spawning or installation.

### Approved one-command owner launch (unreleased)

In an idle unsupervised Herdr Pi session in the target checkout, the user's
`/start-implementation <agreed assignment>` is the opt-in to launch one fresh,
non-writing owner under the existing supervisor. No follow-up confirmation in
that pane. The launch uses the delegated bootstrap and verifies enrollment before
sending the assignment. Only the exact launched owner inherits the bounded grant
for one writer and read-only reviewers. Loading a skill, interpreting model text
or merely installing the package does not launch anything. Existing pauses,
writer conflicts, identity checks, retained attempts, and user decision waits
continue to apply. This extends P1/P5/P6/P7 without changing advanced controls.

### Approved coordinating-owner amendment (since v0.4.0)

A coordinating owner is an exact Pi session that explicitly registers as a non-writing
material-notice recipient (`/continuation-coordinator owner`) and then separately
starts supervision (`/continuation-worker start`) under the existing global supervisor.
The two confirmations are independent. A normal coordinator remains distinct from a
worker; a supervised owner is neither an implementation writer nor the global
supervisor. The owner can obtain a scoped `writer` delegation grant for its assignment.
The existing checkout writer fence excludes only that exact verified non-writing
parent owner; another supervised worker or retained writer claim still blocks a
second writer. An unsupervised planner need not enroll and is never a default inbox.

A delegated child pins the parent's exact owner recipient (also inherited by its
read-only descendants). Material notices for that assignment address this recipient,
not the Herdr workspace's single legacy route coordinator. Workspace route pauses
remain independent, but loss or uncertain delivery of an owner-bound notice isolates
its child rather than pausing unrelated same-workspace assignments. Legacy route
bindings and notices retain their existing semantics. No pane label or workspace
layout confers authority.

An owner may durably declare `continuation_owner_wait` with named exact child IDs or
a user-decision wait. Child wait suppresses repetitive owner-stop attention and only
a matching child material notice wakes the owner; receipt and native stop checks
remain intact. A user wait suppresses automatic wake, inherited child delegation
and direct stale owner continuation. Human `/continuation-owner resume` confirmation
after the actual decision persists a release fence rather than flushing notices;
only the following ordinary user-input turn's successful settlement clears it.
Pending notices then deliver without preempting the selected instruction. Aborted
or held turns and reload retain the fence. That command is not a decision, hold
clear, scope activation, review finding selection or permission to apply unselected
fixes. No timer, synthetic completion or automatic selection inference is added.
Only isolated fake-session tests cover this amendment; installation, live enrollment,
release and cross-platform runtime acceptance are separate.

### User-approved contextual management amendment (since v0.3.0)

The ordinary extension adds `/continuation`, a native menu for the current session
and readable known worker labels, with exact identity available in Details. It
reuses human confirmations and existing own-session Return; it does not add a model
activation/hold-clear capability. Pause remains listed but inactive. Retained Stop
withdraws the exact worker from the active list while retaining identity, history,
checkpoint, budgets, handled stops, receipts and notices; unresolved effects refuse
Stop. Only a fresh explicit OWN-session Start/Return may rejoin. A pre-Stop start,
independent pauses, holds, consumed stops and uncertainty cannot be bypassed by
returning. Permanent replacement retirement remains distinct. This extends the
human control surface within P1/P3/P4/P7, not the seven-scenario acceptance set.

Display-only Herdr annotations reuse the existing Agents/Spaces views and native
snapshots. Exact verified bindings receive compact, namespaced, expiring labels;
workspace counts are reported separately. Native activity and pane labels remain
Herdr-owned. Badges never grant eligibility or control; their absence does not
prove that no other supervisor exists. See [setup and display limits](herdr-annotations.md).

## Observable baseline scenarios

These seven scenarios are the bounded acceptance set, not an exhaustive matrix.
Material work names its scenario; tests verify these outcomes rather than invent
new requirements. Use fake sessions/transports and owned temporary state until
separate live-use authority exists.

| ID | Setup → action → expected result |
| --- | --- |
| P1 — registration/identity | Normal Pi loading, an unregistered TUI session (including a fresh blank start) → explicitly register it, then replace its pane/session identity → installation alone does nothing; registration pins identity/checkpoint and captures a current idle report without sending a task; advanced enrollment stays paused, whereas start explicitly confirms its bounded enrollment/activation and delegated start uses only its scoped user grant for the newly created exact child; replacement is never followed automatically; worker start may explicitly confirm retirement of a verifiably inactive old session and fresh registration, otherwise it refuses. |
| P2 — idle continuation/interpretation | Registered active exact worker, fresh eligible settled stop, approved unfinished assignment → supervisor reads final reply and pinned checkpoint against all obligations and resumes → one native continuation of that assignment, not a new authority grant; ordinary tasks in a start-opted-in worker need no manual rearming; a positive review alone never proves whole-assignment completion; delegated workers enroll before receiving their assignment and may subdelegate only within inherited scope. |
| P3 — blocked/approval | Exact worker reports blocked, or final reply asks for a genuine approval → reconcile and attempt disposition → blocked attention exists even without a completed assistant stop; resume is refused while blocked/held; ordinary task text does not clear a deliberate interruption or unresolved approval; model routes a material decision or pause, never supplies approval; awaiting user finding selection must remain a decision pause. |
| P4 — scoped pause | Active sibling scopes → user pauses one worker/route or global scope, then an event arrives → affected continuation stops, unrelated scopes retain their settings; a model disposition cannot lift the user pause. |
| P5 — dedup/bounds | Repeated unchanged stop/event and no evidenced checkpoint progress → repeated reconciliation/disposition → no duplicate stop delivery; two nudges without progress exhaust the worker budget; a stalled supervisor gets one corrective wake before escalation. |
| P6 — material notices | Exact coordinator or assignment owner and a material blocker/decision or whole-assignment completion → deliver, repeat, then replace/busy the recipient → one identity-bound notice, no routine chatter or same-workspace cross-routing; definite pre-acceptance deferral remains pending and ambiguous delivery pauses the affected scope for inspection, not blind retry. |
| P7 — bounded recovery/ownership | Selected-worker witness and preserved history → hand off paused, attempt inherited-stop replay, or lose owner during delivery → one continuation owner, no inherited/ambiguous replay; explicit inspection/resolution and safe inactive rollback preserve sibling state/history. |

Source tests and independent review must check alignment with these scenarios.
Owner completion is not user acceptance. Hidden/unreported native dialogs and
whole-native-UI proof do not silently enlarge this set.

## Ordinary entry path and remaining acceptance

`src/extension.ts` selects the ordinary continuation profile. Human-confirmed activation is available without the SDK-only experimental gate. Advanced setup creates paused scopes; the approved start commands combine only their explicitly described opt-ins. Normal extension loading does not need a first-command-line-extension ordering assertion. Synchronous guards for observed shared UI and native lifecycle/input holds remain; removing an exhaustive-coverage prerequisite is not removal of those guards.

A final Herdr recheck before addressed continuation preserves the old near-delivery refusal. Blocked attention is supervisor-owned status evidence, distinctly labeled, not a fabricated worker reply or resumable worker observation. Only material disposition is allowed while blocked.

Isolated tests/review establish source behavior, not real-worker or platform acceptance. No live installation, npm publication, registration, migration or shared supervision change is authorized by this document. Existing approvals and independent review/acceptance remain mandatory.
