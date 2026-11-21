# Native continuation contract

The user-controlled target and bounded observable acceptance are in [extension-parity.md](extension-parity.md), P1–P7. This document describes implementation invariants, not additional product requirements or a whole-native-UI acceptance gate. Development baseline: Pi 1.5.0 and Herdr protocol 22; not a compatibility/platform certification.

## Ordinary lifecycle, identity and approval

`extension.ts` selects `ordinary.mjs`, which binds worker, supervisor, coordinator and scoped delegation through normal Pi loading. Installation starts no continuation owner, registration or activation. The ordinary profile does not require command-line ordering, an SDK launcher or an experimental activation environment flag. Advanced setup creates paused independent scopes; the user-approved start commands combine their bounded opt-ins as described in P1–P7. Lower-level experimental helpers are not the ordinary package contract.

Pi's `agent_settled`, not `agent_end`, is the final notification. Aborted/provider-error outcomes are held, not ordinary completion. Since v0.3.3, an intermediate `tool_execution_end.isError` does not itself latch a hold: Pi may recover within the same run. Tool errors still interrupt provisional registration/startup before publication. Native tool results remain in Pi's journal; no raw tool payload is copied into continuation state. A normal fresh final reply still needs the existing whole-assignment assessment; it is not proof that an unresolved blocker or approval disappeared. `before_agent_start` distinguishes user and custom messages. `session_start` covers replacement/fork/reload; a binding never follows another session automatically. Native session identity includes its saved file, ID and leaf. Session entries and `pi.events` are process-local, not a cross-process bus.

Herdr owns agent reporting. Native identity joins session path, terminal, pane, cwd, tab and workspace. Only saved Pi TUI sessions with exact Herdr `path` references are supported; ID-only references are refused, not guessed. `state_change_seq` and `completion_seq` support near-delivery checks, but are not durable native stop IDs across Herdr restart. Subscriptions invalidate discovery: subscribe then snapshot, refresh after overlap/loss; loss pauses global continuation. Follow native endpoint mapping (Windows named pipe, otherwise injected socket path).

A resumable stop is worker-generated and pins native identity, generation and a bounded assistant final reply (maximum 8192 UTF-8 bytes). Missing/blank/oversized replies and absent/legacy holds remain held. The supervisor interprets final reply plus pinned checkpoint against the **whole assignment**. Genuine approval requests, ambiguity, aborts and errors must not be resumed. An exact final-reply excerpt may justify a material decision/blocker/pause, never resume or completion without checkpoint evidence. Interpretation is not new authority or a guarantee against every model misreading.

Herdr may report blocked before any assistant stop exists. The supervisor owns a separate `blocked` attention map with an advisory UUID and state-change sequence. It emits clearly labeled status evidence, never writes a fabricated worker observation/reply, and permits only material hold disposition for that token. The live identity/status/sequence must still match at disposition. An unchanged event retains its token; a new blocked sequence gets new attention. Resume/acknowledgement/completion still require an actual eligible idle worker stop.

Shared-UI calls are synchronously observed before display. Registration/hold-clear confirmations pin prompt revisions. External prompts, failed settled runs, checkpoint-persistence errors and Escape create sticky holds; closing a dialog or starting a turn cannot clear them. Advanced registration retains sticky keyboard holds. Start-opted-in workers fence raw typing immediately, but ordinary interactive/RPC input releases only a provisional typing hold and invalidates the old report before any agent startup; a later input handler consuming the task cannot expose that old stop. Detected wrapper displacement stays invalid even if restored. These existing protections remain, but do not claim exhaustive native/third-party UI observation. Hidden/unreported prompts and cross-process changes between checks are baseline limitations, not reasons to silently expand scope or bypass genuine approvals.

New run/checkpoint error holds include optional `holdError: { kind: "run" | "checkpoint", at: <ISO timestamp> }` alongside the existing hold fields. `at` is when the hold was recorded, not a reconstructed failure time. The cause alone grants no eligibility; old records remain readable and held without fabricated cause/time. Sidebar labels and Details use this evidence, not raw provider/tool error text. A managed checkpoint failure on an otherwise successful settled report can also retain its exact report and checkpoint hash. On restore, an unchanged native report and a fresh durable write of identical checkpoint text restore only that same stop, without replaying the turn. The supervisor independently checks exact identity, eligible settled state and checkpoint bytes before lifting only its own checkpoint-unavailable worker pause. Explicit pauses, decision dispositions, unresolved deliveries, failed turns, changed reports and legacy errors stay held. Other scope pauses and effect history are untouched.

## Supervised coordinating owners (since v0.4.0)

`/continuation-coordinator owner` registers an exact non-writing recipient in the
current Pi session; `/continuation-worker start` independently confirms worker
supervision for that same session. The global supervisor remains separate. The
owner registration must match its worker binding in session, file, pane and owner
state; ordinary coordinators still cannot enroll as workers. The scoped delegation
parent retains a writer *ceiling*, not a writer claim: only the verified coordinating
owner is omitted from the existing checkout's supervised-worker writer-conflict
check. Other supervised workers and durable writer claims still exclude a second
writer. Neither role nor grant makes the owner a source editor.

Delegated children pin the exact owner recipient on joining, including inherited
read-only subdelegations. A material notice persists the recipient with its worker
and route. The supervisor rechecks live Herdr identity, native stop/checkpoint,
route pause and ownership before addressed delivery; the recipient independently
checks its session, binding, owner token, notice status, wait state and one-use
receipt. A busy or user-waiting owner defers before acceptance. An ambiguous
owner-bound delivery pauses only that child; old route-coordinator notices keep
their route-level behavior. Loss of an owner recipient similarly isolates only
its child. Same-workspace owner siblings never share an implicit inbox. Neither
recipient identity nor Herdr labels grant task or approval authority.

`continuation_owner_wait` writes a child wait tied to exact already-supervised child
IDs, or a user-decision wait, through the existing supervisor owner endpoint. It
cannot clear a user wait. A current completed owner stop is acknowledged while
waiting so it cannot be nudged again when the wait ends; this is not assignment
completion. A matching material notice consumes a child wait only after the
existing receipt confirms delivery. A user wait defers all notices to that owner
and rejects further delegation, including inherited already-dispatched children.
Direct owner continuation is refused at the disposition and effect boundary. The
confirmed own-session `/continuation-owner resume` records a durable release
fence after the user has supplied the decision; it does not flush pending notices.
Only a subsequent ordinary interactive/RPC user turn that completes without a
hold clears that fence, after which pending notices may deliver. Aborted/held
turns, synthetic messages and reload do not clear it. Neither command grants
approval, selects findings, clears a worker hold or activates scopes. Waits and
release fences live in the retained supervisor snapshot and survive reload. There is no
second scheduler, polling service or automatic user-selection wake. This source
path has isolated tests, not live adoption or package-release evidence.

## Contextual human management (since v0.3.0)

`/continuation` uses native guarded selection and confirmation, not model-callable
activation or synthetic input. It shows the current session, readable known worker
labels, and details including independent pauses, hold state and spent nudges.
Current source prefers Herdr pane labels, then agent names/terminal titles. Exact
current native bindings appear in Current workers; retained closed/replaced bindings
are accessible through Previous / unavailable registrations with Pane closed or
Session changed reasons and read-only Details. Missing observations do not make an
otherwise current binding historical. This is presentation only: no registrations,
scopes, history or ownership are changed by grouping or browsing. Stopped bindings
remain withdrawn from both lists, with own-session Details/Return still available.
This menu refinement follows v0.3.0's original flat list.
Duplicate labels remain separately addressed. Cancellation, changed caller/target
identity or owner replacement refuses the stale action. Missing/corrupt observations
remain visibly unknown; raw record/error payloads are not displayed.

Pause/Stop requests persist one-use native confirmations pinned to the requesting
Pi/Herdr identity, exact target binding and supervisor session/owner. The existing
owner endpoint revalidates these under the worker ownership mutex and serializes
the durable transition. This IPC accepts only Pause and Stop, never activation or
hold-clear. Loss/uncertainty is inspection work, not replay permission. Native own
Return and supervisor-global controls reuse the existing confirmed start/control
paths; another session cannot remotely clear a worker's hold.

Pause stays in the active list. Retained Stop keeps the worker binding and keyed
history but marks it stopped/paused and withdraws it from active attention/listing.
It refuses unresolved resume/notices or related unfinished delegated startup.
Checkpoint, observations, receipts, budgets, handled stops and notices are not
removed or reset. Ordinary activation and model dispositions cannot rejoin it.
Only a fresh confirmed own-session Start carrying the current per-Stop token can
return; a Start confirmed before a concurrent Stop is stale. Return preserves any
worker pause predating Stop, independent global/route pauses and all no-replay and
budget guards. Existing resolved-hold confirmation remains required. Permanent
replacement retirement is a distinct operation and is not reused for Stop.
Do not downgrade a stopped retained registration to binaries lacking this contract.

## Registration and effects

Registration pins an existing canonical checkpoint and rejects duplicate paths or worker/control-role collisions. Ordinary plain enrollment captures an already-idle report after session-entry/ready publication, using the current leaf; error/missing-reply reports stay held. A working enrollment requires a fresh assistant report, not a prior idle reply. Capture sends no task and activates no scope; handoff still marks its inherited stop handled/no-resend. The optional JSON `--start` envelope separates checkpoint from explicit initial user text. Setup is provisional until its synchronous ready marker; prompt/input/turn/session interruption prevents publication/message dispatch. No await separates final live checks, ready commit and initial message dispatch. A void send API is not acceptance: a matching `before_agent_start` then `agent_start` confirms the initial run. No matching run in 30 seconds creates a hold without blind resend. Restart while pending remains held.

Confirmed pane reuse (since v0.3.0): a worker-start collision with exactly one different saved session in the same pane may return a replacement preview, not acceptance. A separate guarded native confirmation persists a fresh one-use opt-in naming the exact old worker. The supervisor holds both session ownership mutexes, verifies the old registration and live absence, rechecks both identities/opt-in and pending delivery, then commits old-binding retirement and new joining together. An old session still reported anywhere in Herdr, unresolved resume, pending/sending/uncertain old-worker notices, shared checkpoint, unknown/busy ownership or changed confirmation refuses replacement. Independent scope pauses survive. `retiredWorkers` retains the paused old binding and replacement worker ID; old keyed histories, files and receipts remain untouched. Retired sessions cannot be re-added, activated or inherit fresh budgets. A fresh session receives no inherited approval/task authority. Lost acceptance still holds without blind retry. Older binaries do not enforce retirement tombstones: do not downgrade against this state without explicit recovery inspection.

Start enrollment creates a private managed checkpoint from Pi's native model-visible projection: user/assistant narrative and compaction/branch summaries, excluding system/tool/thinking/image payloads and volatile bookkeeping. It requires no model-maintained declaration. Existing manual checkpoint pins are retained without rewriting their contents. The blank-session correction permits fresh managed enrollment before native Pi creates its journal: the future canonical path is pinned, no journal or task is fabricated, and delivery still requires the actual file. Ownership witnesses and the same per-session mutex apply before and after persistence; observing the journal retires the provisional state. Missing established journals and handed-off journals remain failures. The worker publishes a confirmed one-use start nonce for the current owner, then joins over the existing owner endpoint; the supervisor revalidates native identity, readiness, ownership and pending ambiguity before committing activation. Only a new route starts enabled; independent existing route/global pauses survive worker start. Repeated delivery of the same join cannot undo a later pause. Lost responses hold the worker without automatic retry; installation and supervisor start never discover/enroll visible workers.

Delegated startup (since v0.3.0) follows the user-approved amendment in [extension-parity.md](extension-parity.md). A guarded parent scope grant pins its native identity, canonical cwd and exact running supervisor owner/session. Only a freshly created pane's blank startup may open its one-shot bootstrap endpoint. The worker and supervisor independently validate the persisted attempt, inherited grant, owner, native identity and independent pauses before joining. `pane.split` and `agent.start` are native protocol-22 operations; no task text, arbitrary CLI arguments, SDK launcher or UI-confirmation simulation is used to start Pi. The ordinary extension must already load in the new session.

The parent exclusively claims assignment-key/task records and, for a writer, verified Git working-tree ownership before effects (Git on PATH is required for writer delegation). Published v0.4.6 used the common Git directory; retained legacy grants and claims preserve that identity until their original working tree can be verified. Attempt phases are `prepared`, `creating`, `starting`, `enrolling`, `dispatching`, `dispatched`, or `held`; each effect has durable prior intent. Rejected/lost responses leave claims/history retained without replay, automatic child teardown or writer release. The initial-task receiver claims an `accepted` receipt before injection and marks it `sent` only after matching native run events. Pending bootstraps survive reload as holds. Continuation receivers require a `dispatched` attempt; a held or unfinished attempt cannot become resumable merely from a successful-looking final report. Supervisor attention isolates held attempts. Recovery requires inspection, not ordinary Clear/start or deleted records to manufacture retry eligibility. Native first-task journal materialization between ownership reads is accepted only for the same canonical pinned regular file; symlinks and missing established files remain fenced.

These grants coordinate trusted cooperating extensions/agents under the same OS user, not hostile same-user code or semantic task-scope enforcement. Read-only descendants cannot request a writer; existing supervised workers and retained writer claims prevent a second delegated writer for that canonical working tree, even from different subdirectories or spaces. An unverifiable existing worker checkout blocks new writer creation pending inspection; only a successfully verified different checkout is treated as unrelated. The planning parent must relinquish editing. Scope revocation stops further delegation, not existing supervision; use existing independent pause controls for that. Awaiting user selection of independent-review findings remains a decision pause, never automatic-resume authority.

Since v0.5.0, native owner start can select a named or absolute local checkout from the agreed assignment, asking once when multiple discovered targets match. For bare launch, earlier applicable user constraints remain in the owner task but cannot themselves designate the checkout; an explicit scope with conflicting named and absolute matches asks rather than preferring an arbitrary path. An unverifiable explicit checkout path refuses before effects. The planner's cwd and registration are unchanged; the chosen checkout becomes the owner and writer cwd. Independently verified active non-writing owners may share a tree; their writers still compete for its single writer claim. A live exact writer in that checkout may prompt for a new linked worktree on a separate branch. The confirmation shows repository, base commit, branch and path before one Git creation and launch. Cancellation creates nothing. A durable intent is claimed before Git creation; uncertain effects are retained, not retried under a different branch or path. An unresolved owner launch, an unaccounted-for claim, or a conflicting historical registration cannot be bypassed with the worktree option. This change does not alter approvals, holds, route/worker/global pauses, review selection or one-use delivery. Installing v0.5.0 does not update already-running sessions; reload participating roles separately before using the new workflow.

Sequential assignments in one working tree require a new native `/start-implementation` action, not an idle pane, completed child notice, or merged PR. An explicit `--options {"closeAssignment":"<A-grant-id>"} -- <B scope>` names A and authorizes its closeout without a second confirmation; otherwise an eligible prior assignment yields one Close A and start B choice. The same command is available in the finished exact owner's pane through its native control, but it mints a fresh owner and grant rather than reusing that role. The supervisor rechecks the old grant, owner, writer claim, settled worker observations, active status, pending decisions, notices and startup effects under the B launch fence. Closeout retires the exact old bindings, revokes A's delegation grant and releases only its writer claim, preserving observations, notices, receipts and history. The B launch then repeats ordinary eligibility and exact enrollment. A rejected/uncertain closeout or pane effect remains held for inspection, not retried under another key. This closeout authorization is not proof that any missing independent review or owed Git delivery passed; those remain the owner's responsibility before seeking B. No branch, files, pauses outside A or live registrations are reset by this source behavior.

A paused historical binding with a matching saved approval is not silently eligible: its unanswered approval remains a blocker. When its exact session is positively absent, registration and startup match, and no other checkout blocker or unresolved effect remains, the native owner start offers one explicit abandon-old-and-start choice. The supervisor rechecks the exact launch fence, observations, absence and checkout eligibility under its serialized ownership queue before retiring only that old binding. The saved approval, worker registration and history remain untouched; retirement removes the old assignment's authority without answering it. Cancel creates no pane and retires nothing. A requested abandonment is durably fenced before sending it to the supervisor; lost or rejected acknowledgment remains held for inspection, never replayed as a preflight retry. This does not release other pauses, pending effects, or old writer claims.

Native owner start may ignore a paused historical worker for checkout eligibility only when fresh Herdr snapshots and the targeted pane query agree that its exact session is absent, even if a different exact Pi session occupies its old pane. Live or relocated sessions, ambiguous observations, unresolved effects or decisions, and retained writer claims still block. A proved pre-split refusal says no agent started. Current source retains the same scope/key and a durable preflight refusal history; after a prerequisite is corrected, the original command can recheck eligibility and use the same attempt, even after planner reload. The split-request marker is persisted before the first native pane effect. A changed key, prior worktree creation, legacy record without proof, crash after that marker or lost split response remains held; no effect is replayed. Published v0.5.0 retains its earlier pre-split claim limitation. Current source also merges worktree approval and current/new-space placement into one exact selector; an explicit repository, HEAD base, branch and absolute worktree path in structured launch options requires no duplicate prompt. An explicit new-space launch uses native `workspace.create` instead of `pane.split`, with a durable request marker before the effect, then starts ordinary Pi in its root pane. The owner and delegated writer share that space while the planner remains in its original one. A lost workspace response stays held; neither placement changes writer identity or independent pauses. Since v0.6.0, the command can create a separate supervisor space first when no owner is running: the parent intent is durably claimed before native creation, the new Pi session checks its intended pane and saved-session presence before claiming the ordinary supervisor endpoint, and the planner verifies the exact native session and owner before continuing. An uncertain creation/start or retained owner lock is not replayed; a graceful shutdown leaves the prior state in place for a new supervisor. Neither startup nor ordinary global-pause resume clears independently paused routes, workers, decisions or review holds.

Before splitting, the running supervisor may archive checkout-relevant ordinary blocker notices in the same invocation. Its serialized notice path requires durable never-attempted evidence pinned to the intended recipient, no receipt or unresolved startup/resume/decision, and fresh absence of both exact sessions. `archived` means **not delivered**; the notice, identities, timestamp and reason remain in supervisor status/state. It does not resolve the underlying work or lift any pause or hold. Launch rechecks eligibility after archival. Legacy pending notices without that evidence remain blocking. Supervisor snapshots with the new notice evidence use schema 2; older runtimes refuse them rather than silently treating that evidence as safe or replaying an archived notice. Do not downgrade against such state.

Since v0.6.0, delivery preferences live in a private per-user `delivery-preferences.json` under the ordinary state root. An owner-launch grant pins a validated snapshot for that new assignment; a separate assignment-keyed record holds only an explicit owner override, never rewrites the grant or global default. The native menu stages choices until Save; Cancel/Escape writes nothing. The model-facing exact-owner read tool exposes only effective choices, with Automatically Fix clamped to Ask First while human finding selection is required; the owner’s native menu still shows its saved draft. A preference is not repository permission or a Git/review/worker effect, and an existing owner does not inherit later global changes.

One supervisor writes scopes, budgets, dispositions, notices and continuation intents. Each worker owns observations/receipts. Local sockets signal addressed delivery; durable records remain authority. Native Herdr `agent.prompt` lacks an expected-session/stop precondition and is not the continuation transport. Unix uses private local sockets, Windows named pipes. Framing is bounded UTF-8; listeners handle one request per connection and drain accepted handlers on shutdown.

Resume intent is persisted before delivery. After persistence, the supervisor rechecks Herdr identity, idle status, state/completion sequence, subscription and its own interaction/scope state. A definite mismatch rejects the intent, pauses the worker and spends no nudge; there is no accepted-delivery ambiguity to resolve. Transport failure after dispatch remains uncertain. The receiver claims a one-use receipt and rechecks exact stop/session/leaf, generation, durable/local hold, active owner and all pauses immediately before native message injection. A crash between receipt and injection is ambiguous: suspend/inspect, never retry. Loss after acceptance cannot revoke an already accepted effect.

Two nudges without evidenced checkpoint progress exhaust only that worker's budget. One corrective supervisor attention turn precedes local escalation. Material blocker/decision notices dispose/pause the worker even while deferred. A busy/blocked exact coordinator stays pending on definite pre-acceptance refusal; lost coordinator identity pauses its route, lost worker/checkpoint only that worker. Uncertain delivery requires inspection. Completion requires whole-assignment interpretation, an exact checkpoint excerpt, cleared hold, eligible idle stop and full-file `reportHash`; dispatch and recipient recheck freshness. A hash is freshness, not semantic proof or independent acceptance.

## Persistence and module boundaries

- `ordinary.mjs` composes native roles, contextual human management and the scoped delegation binder; `delegation.mjs` owns parent grants, one-shot spawn intents, bootstrap handshake and inherited-scope validation; `session.mjs` reads Pi identity. Historical SDK launcher/runtime/editor/trust sources are excluded from the ordinary npm payload and preserved on the labelled experimental branch.
- `observation.mjs` owns worker lifecycle, registration and durable holds; `checkpoint.mjs` renders native projected task/result evidence; `prompt-guard.mjs` owns observed shared-UI revisions/confirmations/integrity. Optional historical scope stamps remain readable and cannot silently downgrade an eligible stop.
- `management.mjs` owns the contextual menu and native Pause/Stop requests; `status.mjs` derives display-only labels, never eligibility or authority. `annotations.mjs` projects these labels through the existing supervisor lifetime and subscribed native snapshots into namespaced, sequenced, expiring Herdr pane/workspace tokens. It checks exact owner/native bindings and handoff, clears its own source on loss/removal/shutdown, and never owns eligibility or changes permissions. Metadata cleanup does not delay withdrawal of the authority subscription/endpoint. See [sidebar setup and freshness limits](herdr-annotations.md).
- `supervisor.mjs` owns confirmations, Herdr attention, resources and effect ordering; `policy.mjs` owns deterministic disposition/budget/recovery transitions, never I/O or activation. `attention.mjs` labels untrusted evidence without interpreting it.
- `bindings.mjs` joins native identities and enforces pinned checkpoints; `herdr.mjs`/`subscription.mjs` own discovery; `ipc.mjs` owns local framing/lifetime. Worker and coordinator receivers own final acceptance.
- `contracts.mjs` decodes supervisor/observation `schemaVersion: 1`, independently of stop-generation `version`. Original unversioned records stay readable: old handled stops retain conservative no-resend guards; missing hold is held. The advisory `blocked` map is additive and defaults empty only when absent. Malformed fields/unsupported formats fail closed, not into empty authority.
- `diagnostics.mjs` retains the latest original cause in memory and reports only allowlisted classifications, not raw paths, exceptions or checkpoint content. Observation persistence failure leaves its worker inert; supervisor persistence failure withdraws ownership.

## Selected-worker ownership handoff (source preparation)

`ownership.mjs` supplies a witness for cooperating owners under the destination root's canonical `ownership` directory. The key hashes the canonical saved session path; the witness pins session ID, checkpoint, destination root, worker ID and one-use handoff UUID. It is not a defense against arbitrary same-user programs or an unmodified external supervisor. No active legacy adapter is installed by the package.

Preparation holds the old registry lock and a per-worker exclusive `mkdir` effect mutex. It persists `prepared` (neither owner acts), reserves/pauses only the selected old worker through the separate adapter, then persists `owned`. Failure never automatically rolls back. The adapter retains selected-worker history, pauses, budget and pending actions privately; sibling workers remain untouched.

After separately authorized transfer, `/continuation-supervisor handoff <JSON reference>` attaches that exact witness to a newly bound paused worker. It activates nothing, marks the inherited stop handled/no-resend and starts with exhausted initial budget against the checkpoint. A later stop requires evidenced progress. Old pending notices are not silently reconstructed/redelivered. Missing/changed witness prevents activation/acceptance; ownership loss isolates the worker.

Availability reads outside the mutex never grant effect authority. Activation/delivery lock and revalidate ownership. Addressed delivery/notice attempts persist sticky `used` before effects, including rejected/uncertain attempts. Unattached bindings check the deterministic witness path too; skipping attachment cannot bypass transfer. A standalone effect records conservative usage so later preparation requires reconciliation.

Rollback under both locks refuses a used witness or changed session/report, persists `returning`, restores only the selected old worker **paused**, then persists `returned`. It restores supervision metadata, never session/report files or sibling state. Interrupted restoration keeps both sides fenced and may retry the same idempotent restoration. Used transfers need forward reconciliation, not snapshot rollback. Retained witnesses cannot be overwritten; busy/malformed witnesses fail closed. No PID/age-based abandoned-lock stealing. Never remove a live mutex/owner lock.

Human Clear/start may expose only the current unchanged successful held report
for supervisor reassessment, preserving its nonce. Start-mode input fences may
park that same previously idle report, never mint a replacement stop. Neither grants action approval, resets budgets or permits replay. Clear activates
nothing; confirmed worker start enables only its described scope. Exact
identity/leaf/generation/reply and native idle/hold checks remain; stale,
consumed, ambiguous, abort/error and missing reports remain ineligible under
the existing observation, supervisor and receipt guards.

These are source-level protections, not live handoff acceptance. Separately authorized adapter installation and selected-worker rehearsal are still absent. Never run two supervisors over the same worker or reset observations/budgets to force recovery.

## Evidence and remaining authority

See [validation](validation.md) and P1–P7. Isolated checks and independent review are not user acceptance or permission for live installation, secrets, real-worker rehearsal/migration or npm publication. No exhaustive native-UI proof is required for this bounded ordinary-extension contract. A newly found weakness becomes scope only after an actual baseline regression is established; material workflow/safety changes require the user's decision.
