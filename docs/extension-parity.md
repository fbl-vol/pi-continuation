# Ordinary extension continuation contract

The delivery target is an ordinary Pi extension, loaded through Pi's normal extension/package mechanism. Experimental SDK worker-host and native-UI investigations are deferred; no custom launcher, fork, structured stop declarations or exhaustive UI interception is required.

## Bounded baseline

The baseline comparison used the available local continuation workflow and its isolated adapter, not a claim of stronger guarantees than that workflow supplied.

**Exact owner decision submission (P3/P4/P7):** One explicit native input in the
waiting owner pane relays only the entered decision to the exact existing eligible
writer. A confirmed receiver receipt releases only the matching owner wait.
Ordinary chat, child notices, cancelled or stale input and independent pauses do
not release it. An uncertain delivery remains fenced without replay. Legacy and
unsubmitted cases retain their separate recovery path. This accepts terminal-input
access as a trust boundary: an agent with that access can type the same answer.

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

A managed checkpoint-write failure may retain the exact successful settled report
for recovery. On session restore, only an unchanged native report and a fresh,
successful write of its identical checkpoint allow that same stop to be reassessed.
The supervisor can undo only its own matching checkpoint-unavailable pause after
rechecking the exact session and checkpoint; explicit worker, route and global
pauses, decisions, unresolved effects and failed runs remain protected. An absent
or changed report, an unwritable checkpoint or legacy failure without retained
proof remains held. This is P3/P4/P7 recovery, not replay or a new acceptance set.

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
and cooperating writer claims survive rejection/crash. Published v0.4.6 allows one
delegated writer per Git common directory; v0.5.0 narrows this to one per
verified working tree as described below. An existing supervised worker in that
tree blocks a new writer; read-only delegates cannot create writers. This coordinates
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

### Approved one-command owner launch (since v0.4.1)

In an idle unsupervised Herdr Pi session in the target checkout, the user's
`/start-implementation <agreed assignment>` is the opt-in to launch one fresh,
non-writing owner under the existing supervisor. No follow-up confirmation in
that pane. The launch uses the delegated bootstrap and verifies enrollment before
sending the assignment. Only the exact launched owner inherits the bounded grant
for one writer and read-only reviewers. Loading a skill, interpreting model text
or merely installing the package does not launch anything. Existing pauses,
writer conflicts, identity checks, retained attempts, and user decision waits
continue to apply. An unresolved launch blocks new owner launches for the same
Git checkout even if the assignment text or originating session changes. The
refusal identifies the original attempt when available. Inspect its retained
record and live pane/session before any recovery; no timeout, rephrasing, or
restart clears the fence. This extends P1/P5/P6/P7 without changing advanced controls.

**Since v0.6.0 (supervisor startup):** If no supervisor currently owns the private
state, the same explicit launch first starts one through ordinary Pi loading in
a dedicated Herdr space, then verifies its exact native session and endpoint
before creating an owner. A gracefully stopped supervisor can be replaced while
retaining worker, route, notice and pause state; an unresolved lock or ambiguous
native space/start effect remains held, never retried as another supervisor.
This is not automatic enrollment on package installation and does not waive
user decisions, independent pauses or review holds. The v0.5.0 release still
requires a running supervisor before owner launch.

**Surviving-owner reviewer recovery (P1/P3/P4/P7):** After a recorded graceful
supervisor end, the exact already-dispatched assignment owner can run
`/continuation` → **Restore read-only reviewer delegation** and confirm the named healthy
replacement once. The confirmation authorizes reviewer delegation only for that
replacement; the original grant and writer claim are not rewritten. Revocation,
pauses, holds, unresolved waits/effects and attempt/receipt history remain in
force. Each replacement needs a graceful-end witness for its immediate
predecessor, even when the original grant names an earlier supervisor. An exact
writer preflight refusal proved to have left no claim or pane effect does not
block reviewer recovery; its attempt stays unchanged and is not retried. A
missing shutdown witness, ambiguous identity or unhealthy replacement fails
closed. This uses the ordinary native Pi confirmation boundary, not a new
input-provenance guarantee.

**Since v0.6.0 (delivery preferences):** `/continuation` offers a native Delivery preferences
menu. Explicit Save persists per-user defaults for future assignments; Cancel
and Escape discard drafts. Each new owner pins its defaults, while its own
assignment may be explicitly overridden without changing the global choice.
The owner sees the assignment choices and can reread them with the exact-owner
`continuation_delivery_preferences` tool. Current source uses Ask First (default)
or Automatic for review fixes; previously saved Automatically Fix reads as Ask
First. Only a compatible owner workflow may use Automatic, and required human
selection always takes precedence. Preferences are not publication, merge or
approval authority; mandatory review, repository and assignment restrictions,
existing waits and independent holds and pauses still apply. Neither menu nor read tool
performs Git, review, retirement, or live state effects.

### Chat-based owner launch (since v0.4.2)

For an Ask First review, the owner can register the numbered findings with its user-decision wait. The user can clarify in that pane without releasing the wait, then select a single finding in ordinary chat (for example, `fix the first only` or `fix finding 2`). The extension delivers only that finding to the exact existing writer after a successful selection turn, then waits for that writer. Other decisions and legacy waits still have the explicit native path. An interactive terminal submission is not proof of human origin; Pi extension input and RPC input do not qualify for chat selection. Independent verification is a separate owner obligation, not implied by the delivery receipt.

The planner can queue an agreed scope in ordinary chat (`Put B: <scope> after A`). The existing owner records completed independent review and applicable delivery at the final Git revision using `continuation_assignment_delivered`. The supervisor binds that explicit outcome to the exact settled owner stop and revision; it does not infer delivery from an idle pane, writer receipt, or reviewer report. If A remains eligible, the first queued assignment starts in the two retained sessions without another command. The outcome is the coordinating owner's account of the work performed, not independent verification by the extension or permission for any publication. A changed stop or revision, unresolved effect or independent pause blocks advancement. `Start <agreed scope> separately` requests an independent owner; if the current tree has a writer, the planner can queue instead or explicitly authorize the proposed separate worktree.

For recovery or explicit closeout of the exact first queued assignment, the original planner can explicitly name A and B in the native close-and-start command. This path closes eligible A and starts B in the same saved owner and writer sessions, with new worker IDs, scope and checkpoints. It keeps the checkout fenced until both task-start receipts are recorded. After interruption the same command can reconcile an observed receipt; a requested start without a sent receipt is not replayed. Queueing alone does not authorize explicit closeout or prove review or delivery obligations.

For other sequential work in one tree, starting B can close an eligible exact A assignment under the same native command. Naming A in structured launch options is the human closeout authorization; otherwise one named choice is required. Active writing, held/unknown reports, unresolved decisions, notices or startup effects refuse closeout. An exact temporary read-only reviewer with a settled completed report may be positively absent rather than live; its absence does not attest to review or delivery. An unknown, relocated or effect-uncertain reviewer still refuses closeout. The old grant and workers lose authority while their history remains readable. New B receives a separate owner identity and grant, even when launched from A's finished owner pane. This does not attest to a missing review, fix verification or Git delivery. After a lost closeout acknowledgement, only the recorded exact B attempt can reconcile its old claim/grant and resume before any pane request; a requested pane effect remains held and is never replayed. Exercise planner and owner launches, cancellation, restart and competing claims in disposable state before claiming the full sequential workflow.

When exact owner, writer and reviewer sessions of a retained assignment are positively absent, normal closeout is not inferred. A verified old writer claim (including a Git-common-directory claim that still resolves to this tree), pending notices without no-send proof, and other historical holds can instead be retired together only after one named abandonment choice for the complete eligible set. The old work is not completed: approvals stay unanswered; notice status, content and receipts remain unchanged, so unknown deliveries are not relabeled undelivered or replayed. Only the selected exact bindings and grant lose authority and only its matching claim is released. A live/reappearing or unknown session, competing claim, in-flight effect, non-pending unresolved notice or uncertain startup blocks retirement before a new pane. After a committed retirement, only the exact pre-pane B attempt can reconcile a lost acknowledgement, including after supervisor replacement; a requested external effect cannot be replayed. This source transition does not authorize live cleanup.

For exact-set abandonment only, a paused, positively absent delegated read-only reviewer may retain a decision disposition for a different known stop than its unheld, completed report. Retirement preserves that disposition unanswered; it neither resumes the reviewer nor approves a finding. A current or unidentifiable decision, owner wait, or uncertain delivery still blocks the transition.

A bare `/start-implementation` is the explicit opt-in. One tool-free call to the
configured model identifies the latest user assignment or agreement to the
immediately preceding assistant proposal from bounded current conversation text.
Those complete turns preserve user corrections; a subsequent assistant proposal
cannot borrow an earlier approval. The model can also cite applicable earlier
user constraints and checks. Only complete, verified user turns are carried as
prior context, not as a separate assignment. No skill
invocation or extra confirmation. Unclear or invalid selection, provider
failure, or a changed planning session creates no owner.
Explicit command text remains supported. Verify a paused historical session with
its pane closed or an exact replacement occupant, plus two checkout-related pending
ordinary blocker notices with durable no-send evidence and both endpoints absent.
One native invocation archives the notices as undelivered, rechecks ownership, and
enrolls exactly one owner before dispatch, without confirmation or retry. Restart and
inspect the original binding, pauses and archived notices. Repeat with a live session,
writer claim, decision, or unproven delivery: the command explains the blocker and
creates no pane. In particular, v0.4.5 pending notices do not prove delivery was
never attempted and remain blocking; the successful archive scenario uses proof
recorded by the new supervisor before its first send attempt. A possibly effected
launch stays held for inspection, not replay. An owner start refused before any
pane creation can reuse the exact retained scope, stable key and attempt after
its prerequisite is corrected, including after a Pi reload or healthy supervisor replacement with the old owner proven absent; the earlier refusal
remains in history. A writer refusal before acquiring its writer claim likewise keeps the same key/attempt for a corrected prerequisite under unchanged authority; a generic held attempt or possible pane effect is not retryable. A closed, paused delegated worker from a removed independent checkout does not block a free tree when its dispatched grant and exact absence retain a verified different tree identity. Manual or otherwise unidentified historical bindings still block when Git identity cannot be established. A matching saved approval on a positively absent historical
session instead requires one explicit abandonment choice in the original command.
Cancel, a live/reappearing or unverified session, unfinished startup, unresolved
effects, or another checkout blocker refuses without retiring the binding. A chosen
abandonment retires only the old assignment authority, keeps its approval unanswered
and history readable across restart, and then rechecks eligibility before exactly
one new launch. Lost abandonment acknowledgment stays held, not replayed. A write-ahead split- or workspace-request marker fences even a lost response,
and a prior created worktree is not a pre-effect retry. Current source also
offers one exact create-or-cancel worktree selection with current/new-space
placement, or accepts an exact approved worktree specification without prompting.
Explicit new-space launch starts owner and writer together without moving the
planner; the current space remains the no-prompt default. Space choice cannot
bypass checkout ownership. Legacy/uncertain attempts remain held. See the [contract](contract.md) for the retained state and compatibility boundary.

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
and direct stale owner continuation. In the legacy recovery path, confirming
**Release this owner decision wait** in `/continuation` after the actual decision
persists a release fence rather than flushing notices;
only the following ordinary user-input turn's successful settlement clears it.
Pending notices then deliver without preempting the selected instruction. Aborted
or held turns and reload retain the fence. That action is not a decision, hold
clear, scope activation, review finding selection or permission to apply unselected
fixes. No timer, synthetic completion or automatic selection inference is added.
Only isolated fake-session tests cover this amendment; installation, live enrollment,
release and cross-platform runtime acceptance are separate.

### User-approved checkout selection amendment (since v0.5.0)

The native `/start-implementation` launch uses the checkout identified by the agreed
assignment, not the planner's current working directory. An unambiguous named or
absolute local checkout launches directly; ambiguous discovered checkouts require
one native selection in the same invocation. Bare launch derives the target from
the agreed assignment, not earlier constraints that remain in the owner's task;
explicit scopes never prioritize an unrelated absolute path over a named target.
An unverifiable explicit checkout path refuses before launch. The planner remains unsupervised and
in place. Owner and writer start in the chosen checkout. Writer claims and worker
eligibility use the canonical working-tree root, including subdirectories and
alternate paths; distinct linked worktrees may each have a writer. Legacy
common-directory grants/claims retain their prior identity and block a same-tree
writer unless their exact tree can be verified.

If an active exact writer owns the chosen tree, the user may explicitly confirm
an alternate linked worktree after seeing its repository, base commit, branch and
path. Git creation and launch occur in that invocation. Cancelling has no launch
or worktree effect; a durable worktree intent prevents retrying an uncertain
creation with a new branch or path. Unresolved owner launches or unaccounted-for
writer claims cannot be bypassed by choosing an alternate tree. Existing pauses,
approval decisions, receipt fences and archived historical state remain unchanged.
This amends P1/P7, not the seven-scenario acceptance set. Source/fake-runtime tests
are not live or cross-platform runtime acceptance.

### User-approved contextual management amendment (since v0.3.0)

The ordinary extension adds `/continuation`, a native menu for the current session
and readable known worker labels, with exact identity available in Details. It
reuses human confirmations and existing own-session Return; it does not add a model
activation/hold-clear capability. Pause remains listed but inactive. Retained Stop
withdraws the exact worker from the active list while retaining identity, history,
checkpoint, budgets, handled stops, receipts and notices; unresolved effects refuse
Stop. Only a fresh explicit OWN-session Start/Return may rejoin. A pre-Stop start,
independent pauses, holds, consumed stops and uncertainty cannot be bypassed by
returning. Permanent replacement retirement remains distinct. Current source also places confirmed own-session hold clearing and exact-owner decision submission in this menu. It retains separate explicit release for legacy or unsubmitted waits. Neither path confers approval or activation. Manual supervisor/worker setup and advanced delegation remain distinct. This extends the
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
