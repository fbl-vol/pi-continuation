# Native continuation contract

The user-controlled target and bounded observable acceptance are in [extension-parity.md](extension-parity.md), P1–P7. This document describes implementation invariants, not additional product requirements or a whole-native-UI acceptance gate. Development baseline: Pi 1.5.0 and Herdr protocol 22; not a compatibility/platform certification.

## Ordinary lifecycle, identity and approval

`extension.ts` selects `ordinary.mjs`, which binds worker, supervisor and coordinator through normal Pi loading. Installation starts no continuation owner, registration or activation. The ordinary profile does not require command-line ordering, an SDK launcher or an experimental activation environment flag. Human-confirmed independent scopes still start paused. Lower-level experimental helpers are not the ordinary package contract.

Pi's `agent_settled`, not `agent_end`, is the final notification. Aborted/provider-error outcomes are held, not ordinary completion. `before_agent_start` distinguishes user and custom messages. `session_start` covers replacement/fork/reload; a binding never follows another session automatically. Native session identity includes its saved file, ID and leaf. Session entries and `pi.events` are process-local, not a cross-process bus.

Herdr owns agent reporting. Native identity joins session path, terminal, pane, cwd, tab and workspace. Only saved Pi TUI sessions with exact Herdr `path` references are supported; ID-only references are refused, not guessed. `state_change_seq` and `completion_seq` support near-delivery checks, but are not durable native stop IDs across Herdr restart. Subscriptions invalidate discovery: subscribe then snapshot, refresh after overlap/loss; loss pauses global continuation. Follow native endpoint mapping (Windows named pipe, otherwise injected socket path).

A resumable stop is worker-generated and pins native identity, generation and a bounded assistant final reply (maximum 8192 UTF-8 bytes). Missing/blank/oversized replies and absent/legacy holds remain held. The supervisor interprets final reply plus pinned checkpoint against the **whole assignment**. Genuine approval requests, ambiguity, aborts and errors must not be resumed. An exact final-reply excerpt may justify a material decision/blocker/pause, never resume or completion without checkpoint evidence. Interpretation is not new authority or a guarantee against every model misreading.

Herdr may report blocked before any assistant stop exists. The supervisor owns a separate `blocked` attention map with an advisory UUID and state-change sequence. It emits clearly labeled status evidence, never writes a fabricated worker observation/reply, and permits only material hold disposition for that token. The live identity/status/sequence must still match at disposition. An unchanged event retains its token; a new blocked sequence gets new attention. Resume/acknowledgement/completion still require an actual eligible idle worker stop.

Shared-UI calls are synchronously observed before display. Registration/hold-clear confirmations pin prompt revisions; observed external prompts, errors, Escape and registered-worker keyboard input create sticky holds. Closing a dialog or starting a turn cannot clear a hold. Detected wrapper displacement stays invalid even if restored. These existing protections remain, but do not claim exhaustive native/third-party UI observation. Hidden/unreported prompts and cross-process changes between checks are baseline limitations, not reasons to silently expand scope or bypass genuine approvals.

## Registration and effects

Registration pins an existing canonical checkpoint and rejects duplicate paths or worker/control-role collisions. Ordinary plain enrollment captures an already-idle report after session-entry/ready publication, using the current leaf; error/missing-reply reports stay held. A working enrollment requires a fresh assistant report, not a prior idle reply. Capture sends no task and activates no scope; handoff still marks its inherited stop handled/no-resend. The optional JSON `--start` envelope separates checkpoint from explicit initial user text. Setup is provisional until its synchronous ready marker; prompt/input/turn/session interruption prevents publication/message dispatch. No await separates final live checks, ready commit and initial message dispatch. A void send API is not acceptance: a matching `before_agent_start` then `agent_start` confirms the initial run. No matching run in 30 seconds creates a hold without blind resend. Restart while pending remains held.

One supervisor writes scopes, budgets, dispositions, notices and intents. Each worker owns observations/receipts. Local sockets signal addressed delivery; durable records remain authority. Native Herdr `agent.prompt` lacks an expected-session/stop precondition and is not the continuation transport. Unix uses private local sockets, Windows named pipes. Framing is bounded UTF-8; listeners handle one request per connection and drain accepted handlers on shutdown.

Resume intent is persisted before delivery. After persistence, the supervisor rechecks Herdr identity, idle status, state/completion sequence, subscription and its own interaction/scope state. A definite mismatch rejects the intent, pauses the worker and spends no nudge; there is no accepted-delivery ambiguity to resolve. Transport failure after dispatch remains uncertain. The receiver claims a one-use receipt and rechecks exact stop/session/leaf, generation, durable/local hold, active owner and all pauses immediately before native message injection. A crash between receipt and injection is ambiguous: suspend/inspect, never retry. Loss after acceptance cannot revoke an already accepted effect.

Two nudges without evidenced checkpoint progress exhaust only that worker's budget. One corrective supervisor attention turn precedes local escalation. Material blocker/decision notices dispose/pause the worker even while deferred. A busy/blocked exact coordinator stays pending on definite pre-acceptance refusal; lost coordinator identity pauses its route, lost worker/checkpoint only that worker. Uncertain delivery requires inspection. Completion requires whole-assignment interpretation, an exact checkpoint excerpt, cleared hold, eligible idle stop and full-file `reportHash`; dispatch and recipient recheck freshness. A hash is freshness, not semantic proof or independent acceptance.

## Persistence and module boundaries

- `ordinary.mjs` composes the three native role binders; `session.mjs` reads Pi identity. Historical SDK launcher/runtime/editor/trust sources are excluded from the ordinary npm payload and preserved on the labelled experimental branch.
- `observation.mjs` owns worker lifecycle, registration and durable holds; `prompt-guard.mjs` owns observed shared-UI revisions/confirmations/integrity. Optional historical scope stamps remain readable and cannot silently downgrade an eligible stop.
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

Human Clear hold may expose only the current unchanged successful held report
for supervisor reassessment, preserving its nonce. It is not action approval,
activation, lifting other pauses, resetting budgets or replay permission. Exact
identity/leaf/generation/reply and native idle/hold checks remain; stale,
previously eligible, consumed, ambiguous, abort/error and missing reports remain
ineligible under the existing observation, supervisor and receipt guards.

These are source-level protections, not live handoff acceptance. Separately authorized adapter installation and selected-worker rehearsal are still absent. Never run two supervisors over the same worker or reset observations/budgets to force recovery.

## Evidence and remaining authority

See [validation](validation.md) and P1–P7. Isolated checks and independent review are not user acceptance or permission for live installation, secrets, real-worker rehearsal/migration or npm publication. No exhaustive native-UI proof is required for this bounded ordinary-extension contract. A newly found weakness becomes scope only after an actual baseline regression is established; material workflow/safety changes require the user's decision.
