# Ordinary extension continuation contract

The delivery target is an ordinary Pi extension, loaded through Pi's normal extension/package mechanism. Experimental SDK worker-host and native-UI investigations are deferred; no custom launcher, fork, structured stop declarations or exhaustive UI interception is required.

## Bounded baseline

The baseline comparison used the available local continuation workflow and its isolated adapter, not a claim of stronger guarantees than that workflow supplied.

| Concern | Preserved contract |
| --- | --- |
| Identity | Explicit saved Pi session, terminal, pane, cwd and workspace; never follow a replacement automatically. |
| Attention | Herdr settled/blocked state; a blocked worker needs attention even without an assistant stop. A repeated unchanged event is deduplicated. |
| Interpretation | Model reads final reply/checkpoint against the entire assignment. Routine unfinished approved work may continue; completion requires all follow-ups. A genuine approval request or uncertain authority is a decision/pause, not new permission. |
| Control | Explicit registration and independent global/route/worker pauses. Model tools cannot activate scopes or clear user holds. |
| Bounds | One delivery per stop; two nudges without evidenced progress, then pause/escalate; one corrective supervisor wake before escalation. |
| Notices | Material blockers/decisions/completion only, exact coordinator identity, pending versus uncertain delivery retained. |
| Ownership | One cooperating owner, selected-worker witness, paused handoff/rollback, no replay of inherited or ambiguous delivery. |

The old workflow rechecked Herdr identity/state near delivery and refused blocked/unknown workers. It used model interpretation for prose approval requests; it did not provide authoritative observation of every Pi-native or third-party dialog. The extension retains that bounded behavior, its existing local prompt/input/error holds and receipt checks. It does not claim to solve arbitrary UI changes between checks, hidden unreported dialogs, or model misinterpretation. Neither a status signal nor model interpretation grants additional user authority.

### User-approved start workflow amendment (unreleased)

The approved `start-v1` workflow adds two explicit opt-ins, not automatic worker discovery: `/continuation-supervisor start` enables the one owner in the current private state scope; `/continuation-worker start` confirms enrollment/activation of that exact worker, derives its route and creates a private checkpoint from native projected task/result text. No user-maintained checkpoint declaration or copied ID is required for a fresh worker. Missing/conflicting ownership is refused, never guessed. Existing explicit controls remain available; an existing manually pinned checkpoint is not replaced or overwritten by start.

For start-opted-in workers, raw typing immediately fences old-stop delivery; ordinary submitted tasks release only that provisional typing fence. Escape/interruption, observed external prompts and errors remain holds. Repeating confirmed worker start returns control for reassessment without answering a pending decision, resetting bounds/history or replaying a delivered stop. It may enable that worker and a newly created route, never lift an independently paused existing global/route scope. Supervisor start explicitly enables the global scope; existing worker/route pauses remain. The alpha.1 advanced-only workflow is unchanged.

## Observable baseline scenarios

These seven scenarios are the bounded acceptance set, not an exhaustive matrix.
Material work names its scenario; tests verify these outcomes rather than invent
new requirements. Use fake sessions/transports and owned temporary state until
separate live-use authority exists.

| ID | Setup → action → expected result |
| --- | --- |
| P1 — registration/identity | Normal Pi loading, an unregistered saved TUI session → explicitly register it, then replace its pane/session identity → installation alone does nothing; registration pins identity/checkpoint and captures a current idle report without sending a task; advanced enrollment stays paused, whereas start explicitly confirms its bounded enrollment/activation; replacement is refused, never followed automatically. |
| P2 — idle continuation/interpretation | Registered active exact worker, fresh eligible settled stop, approved unfinished assignment → supervisor reads final reply and pinned checkpoint against all obligations and resumes → one native continuation of that assignment, not a new authority grant; ordinary tasks in a start-opted-in worker need no manual rearming; a positive review alone never proves whole-assignment completion. |
| P3 — blocked/approval | Exact worker reports blocked, or final reply asks for a genuine approval → reconcile and attempt disposition → blocked attention exists even without a completed assistant stop; resume is refused while blocked/held; ordinary task text does not clear a deliberate interruption or unresolved approval; model routes a material decision or pause, never supplies approval. |
| P4 — scoped pause | Active sibling scopes → user pauses one worker/route or global scope, then an event arrives → affected continuation stops, unrelated scopes retain their settings; a model disposition cannot lift the user pause. |
| P5 — dedup/bounds | Repeated unchanged stop/event and no evidenced checkpoint progress → repeated reconciliation/disposition → no duplicate stop delivery; two nudges without progress exhaust the worker budget; a stalled supervisor gets one corrective wake before escalation. |
| P6 — material notices | Exact coordinator and a material blocker/decision or whole-assignment completion → deliver, repeat, then replace/busy the coordinator → one identity-bound notice, no routine chatter; definite pre-acceptance deferral remains pending and ambiguous delivery pauses for inspection, not blind retry. |
| P7 — bounded recovery/ownership | Selected-worker witness and preserved history → hand off paused, attempt inherited-stop replay, or lose owner during delivery → one continuation owner, no inherited/ambiguous replay; explicit inspection/resolution and safe inactive rollback preserve sibling state/history. |

Source tests and independent review must check alignment with these scenarios.
Owner completion is not user acceptance. Hidden/unreported native dialogs and
whole-native-UI proof do not silently enlarge this set.

## Ordinary entry path and remaining acceptance

`src/extension.ts` selects the ordinary continuation profile. Human-confirmed activation is available without the SDK-only experimental gate. Advanced setup creates paused scopes; the approved start commands combine only their explicitly described opt-ins. Normal extension loading does not need a first-command-line-extension ordering assertion. Synchronous guards for observed shared UI and native lifecycle/input holds remain; removing an exhaustive-coverage prerequisite is not removal of those guards.

A final Herdr recheck before addressed continuation preserves the old near-delivery refusal. Blocked attention is supervisor-owned status evidence, distinctly labeled, not a fabricated worker reply or resumable worker observation. Only material disposition is allowed while blocked.

Isolated tests/review establish source behavior, not real-worker or platform acceptance. No live installation, npm publication, registration, migration or shared supervision change is authorized by this document. Existing approvals and independent review/acceptance remain mandatory.
