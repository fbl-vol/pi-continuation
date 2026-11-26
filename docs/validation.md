# Validation evidence and limits

## Ordinary owner-chat selection from a package artifact

On Linux with Pi 1.6.1 and Herdr 0.9.5:

```sh
artifact_dir=$(mktemp -d)
npm pack --pack-destination "$artifact_dir"
tar -xzf "$artifact_dir"/*.tgz -C "$artifact_dir"
python3 scripts/check-native-launch.py --pi-version 1.6.1 --owner-chat --package "$artifact_dir/package"
```

This starts ordinary Pi sessions under a disposable profile and Herdr server with a
scripted local model. It checks that a clarification leaves the wait in place and
that one ordinary reply delivers only finding 1 to the existing writer. It does
not check independent semantic review, a real model's conversational choices,
release installation in a user profile, or automatic assignment rollover.

The scripted planner backlog check uses the same disposable harness:

```sh
python3 scripts/check-native-launch.py --pi-version 1.6.0 --planner-queue
```

It records two ordered entries from ordinary planning chat while the existing
writer is still working. This checks capture, not automatic start of a queued
assignment. Name the current assignment by its launch title (the text before the
first colon, if present), or use `this assignment` when exactly one active
assignment was launched from the planning session. Supply the agreed scope in
full, for example `Put B: update the documentation after A`. The queue records the
submitted scope as written; it does not reconstruct it from prior conversation.

`--parallel-assignment` rehearses `Start <agreed scope> separately` while the
first writer is still working. It exercises the single worktree choice and
checks both writers are active in separate trees with the original bindings
unchanged.

`--automatic-rollover` rehearses queueing B from ordinary planner chat, obtaining
a scripted review in a separate read-only Pi session, and pushing A's exact
fixture revision to a disposable bare Git remote. The owner records the A
outcome and B starts in the original owner and writer sessions, with no second
human command. Add `--package "$artifact_dir/package"` to exercise the packed
artifact. The reviewer and delivery coordinator are scripted, not representative
real-agent review, user acceptance, or external Git publication.

`--retained-rollover` submits the exact first queued scope through an explicit
native close-and-start command. It verifies A's retirement, two fresh worker
bindings, unchanged saved sessions and panes, and one B run receipt per role.
The scripted model does not establish that real independent review or delivery
obligations have been met; the explicit native closeout authorizes this fixture.
The isolated test suite also exercises interruption before closeout commit,
restart after a lost response with a sent receipt, and refusal to resend when
the receipt is absent. Automatic closeout from review/delivery evidence is not
covered by this rehearsal.

[extension-parity.md](extension-parity.md), P1–P7, is the bounded acceptance set.
Tests/reviews verify it; they do not create requirements. Owner completion is not
user acceptance; whole-native-UI proof is not a hidden gate. No live installation,
real-worker migration, secrets or npm publication is implied.

## v0.3.0 release baseline

The integrated suite passes **283 isolated tests** and the package contains **32
explicit files**. Main-branch CI for the feature revision `8ae5c21` passed on Linux,
Windows and macOS. The earlier reported Windows source-test failures are historical,
not current blockers. Package versions now match the new release tag. This is not
native cross-platform runtime, live adapter, delegated-spawn or real-model acceptance;
the model/platform evidence limits below remain. Historical section counts describe
their original revisions, not the current integrated suite.

## Settled-turn error holds release (v0.3.3)

The integrated source suite passes **306 isolated tests**, with the unchanged
**32-file package payload**. A failed intermediate tool followed by a normal fresh
report remains eligible for existing assessment and one-use delivery. Actual
failed turns, observed approvals, checkpoint failures and legacy holds remain
held. Later failed turns preserve an already-latched hold's original reason/time
through Details and reload. Four provenance cases failed before the selected
correction and pass afterward; resume remains refused.

Independent source review and selected-fix re-review are complete, with no
outstanding material findings. Source-fix CI passes Linux, Windows and macOS.
Eight disposable Linux Herdr 0.9.5 display states checked labels/colors at 42/24
sidebar columns using synthetic session/source attribution. Eighteen native Pi
1.5.2 selector/notification component frames checked readable menus/Details at
80/40 columns and read-only keyboard browsing. These are isolated rendering and
component checks, not real-worker identity, whole live TUI, real-model or native
Windows/macOS acceptance. Existing holds and live supervision were not repaired.

## Worker start and annotation cleanup release (v0.3.2)

The integrated source suite passes **294 isolated tests**, with the unchanged
**32-file package payload**. New regressions exercise bare/whitespace worker
commands through confirmation and blank-session enrollment, directory rejection
before either advanced registration form persists state, structured Herdr error
codes, benign missing-target cleanup and continued reporting of publication/other
cleanup failures. Six focused cases failed against the previous implementation;
all 41 focused checks pass with the correction. Existing valid-file registration,
hold, pause, history and ownership checks remain exercised.

Independent review of the source fix found no material findings; its PR CI passed
Linux, Windows and macOS. A read-only Herdr 0.9.5 missing-pane lookup verified error
code propagation, not live metadata writes or worker recovery. These checks do not
repair existing registrations or establish real-worker, real-model or native
cross-platform runtime acceptance.

## Readable worker menu release (v0.3.1)

Focused management scenarios cover the native `snapshot.panes` label separately
from agent titles, current versus closed/replaced registrations, a live pane with
no agent report, duplicate pane labels with exact selected-worker controls, unknown
observations remaining current, cancellation and read-only previous-registration
browsing even when the original identity reappears. These use synthetic sessions,
fake Herdr snapshots and temporary state through the actual command handler; no
live workers or registrations are changed. Existing Stop/Return and stale-identity
checks remain in place. The integrated source suite passes 287 isolated tests;
package resources remain the same explicit 32-file payload.

Independent review of the menu refinement found no material findings. Its PR CI
passed Linux, Windows and macOS; merged-source CI passed Linux and Windows, while
the macOS job was cancelled before executing any steps. Native Windows/macOS
runtime verification remains unclaimed.

Focused ordinary native Pi 1.5.2 Linux keyboard checks used the packed merged
artifact, isolated profiles/sessions and fake Herdr protocol 22. Three bounded
runs exercised pane labels, current/previous menus, read-only previous Details,
Pause → Stop → own-session Return, retained independent pauses and history, clean
exits and zero model requests. Native selector component frames at 80/40 columns
also covered current, previous, empty and unknown-observation states. These are
not real Herdr adapter, real-model, whole-workflow or user acceptance. No installed
extension, live worker, settings or supervision state was changed by these checks.

## Contextual management source evidence (v0.3.0)

`test/management.test.mjs` exercises the actual ordinary binder, guarded native
command callbacks, owner IPC, disk records and ownership mutexes with fake Pi/Herdr
sessions. It checks selected versus sibling controls, duplicate labels, cancelled
selection/confirmation, caller/target/owner changes, concurrent external prompts,
unknown/corrupt observations and consumed control requests. Retained Stop tests
preserve consumed-stop/budget history and independent pauses, reject unresolved
continuations/notices/startups, distinguish listed Pause from withdrawn Stop, and
refuse a Start confirmed before a concurrent Stop. These are local P1/P3/P4/P7
checks, not live menu interaction, native platform or user acceptance.

`test/annotations.test.mjs` checks namespaced/TTL/sequence payloads, unchanged-event
deduplication and renewal, shutdown clearing including lost first acknowledgements,
separate workspace counts, missing observations, owner/native replacement, stale
snapshots, concurrent Pause and isolated transport/ownership failure. Fake-clock
renewal checks inspect requested TTL; they do not prove native expiry behavior.
`test/annotations-flow.test.mjs` checks the ordinary binder's Pause/Stop/Return
metadata and that slow optional metadata cannot delay authority-subscription
withdrawal on shutdown. Missing/mismatched initial native-owner regressions use
valid workers and assert zero pane/workspace reports while ordinary enrollment
and one exact-stop continuation still succeed; happy display flows pin the native
owner instead of waiving its witness. Prior disposable Linux Herdr 0.9.5 rendering
evidence covers compact narrow labels, token colors, ordinary-row elision, stale-sequence
rejection and pane/workspace TTL expiry—not this adapter's live lifecycle or native
20-worker scale. No current-adapter live or Windows/macOS runtime claim is made.

## Ordinary-extension evidence

`npm test` uses fake Pi/Herdr, real local sockets and temporary state/processes,
not real workers. `npm run check:package` checks the explicit normal extension
payload and rejects experimental SDK launcher/resources.

- **P1:** observation/parity tests cover ordinary registration and human scoped
  activation without first-option startup or SDK opt-in, including enrollment of
  an existing idle report, current registration leaf, retained error/missing-reply
  holds and fresh-report requirements for working enrollment. An isolated Pi 1.5.0
  smoke discovers the packed entry from ordinary package settings, with no
  explicit extension path, launcher, model request or real Herdr connection.
- **P2/P3:** supervisor/receiver/parity tests cover exact-stop delivery, final
  Herdr rechecks, mid-turn blocked attention without an assistant stop, material-
  only blocked disposition and preserved native handled history. Observation/
  prompt-guard tests retain sticky holds and observed shared-UI interleavings.
- **P4–P6:** policy/supervisor/repair/coordinator/parity tests cover independent
  scopes, two-nudge bounds, one corrective wake, no-resend and exact material
  notices with pending/uncertain/freshness distinctions.
- **P7:** ownership/handoff tests exercise competing processes, witness exclusion,
  paused attachment, inherited-stop no-replay and sibling-preserving rollback.
  No adapter was installed into active supervision.

Five selected blocked/final-recheck regressions failed against isolated pre-change
source, then passed on the ordinary implementation. No production source was
modified for that red comparison. Deterministic policy tests are not model judgment.

## Scoped delegation source evidence (v0.3.0, P1–P7)

`test/delegation.test.mjs` composes the ordinary extension with fake native Pi
sessions, fake protocol-22 Herdr creation/start responses, actual local bootstrap /
owner / receiver IPC, and private temporary records. It checks an unsupervised
planning parent, exact-child enrollment before task injection, supervised read-only
subdelegation, scoped native grant/cancellation/revocation, writer exclusion,
unchanged owner identity, independent pauses, replacement identity refusal,
concurrent/duplicate keys and exact tasks, lost creation/start/enrollment/task
responses, accepted-but-unobserved native run, cancellation, and the user
finding-selection decision pause. Guidance checks are not proof of model judgment.

A first-task race reproduced during validation: native journal creation between an
ownership observer's `realpath` and `lstat` falsely paused the new worker. A
controlled real-filesystem regression reproduced the failure before the correction;
it now accepts only the same canonical regular file while existing symlink,
missing-established-journal and ownership fences remain tested.

Native startup/tool/messaging shapes were checked against installed Pi 1.5.2
extension documentation/source and the installed Herdr 0.9.5 protocol-22 schema.
This is source/isolated transport evidence, **not a live delegated spawn trial**,
installation, settings change, real-model acceptance or native Windows/macOS
runtime verification. Subsequent integrated source CI passed on Linux, Windows
and macOS as recorded in the release baseline above; model/platform runtime
evidence gaps remain.

## Blank-session correction (P1/P2/P7)

A real alpha.2 blank-worker start exposed a fixture gap: Pi allocates a journal
path before creating the file, while the fixture had pre-created it. With realistic
lazy persistence, blank enrollment failed before the correction. The source fix
pins the future canonical path only at fresh confirmed managed registration.
Ownership observation/enrollment can await that file, but delivery and handoff
still require persistence. Pending state is retired when the supervisor observes
the real journal; a missing established journal remains an ownership failure.

The corrected blank-start scenario checks no synthetic task or journal creation,
first ordinary-task persistence, pending retirement, one-use delivery and refusal
after journal deletion. Ownership regressions retain the same mutex before/after
persistence and reject premature effects, reserved handoffs and path substitution.
An isolated probe repeats the join with actual native Pi 1.5.0/1.5.2 SessionManager
instances, fake Herdr/transport and temporary state; no model, live profile or real
worker is used. This fix is not in the published alpha.2 and is not live acceptance.

## Confirmed pane replacement evidence (v0.3.0)

The replacement revision's source suite passed **225 tests**. Focused replacement cases use fake native
sessions/Herdr, real local IPC, session mutexes and temporary state. They cover
explicit acceptance/cancellation, old live sessions in another pane, pending or
uncertain delivery, busy/missing ownership records, forged replacement opt-ins,
changed live identity, native confirmation-key input and Escape during confirmation. They also check atomic
binding retirement, retained history/checkpoint, independent pauses, fresh budgets,
retired receiver refusal, no duplicate join effects and retirement across restart.
The original reused-pane failure was reproduced before the change.

An isolated Linux probe repeats confirmed replacement with actual Pi 1.5.0/1.5.2
SessionManager instances and then exercises one-use continuation of a fresh task.
Herdr and confirmation UI are fakes; this is not a real-model/TUI acceptance trial.
Normal packed-extension discovery/binding probes and the 27-file payload check
also pass. No live settings, registrations, worker state, installation or release
was changed; native Windows/macOS runtime verification remains absent.

## Alpha.2 start workflow evidence

Published `v0.1.0-alpha.2` packages the merged start workflow. Earlier real-model
trials below used pre-start-workflow revisions; they are not real-model acceptance
of the start commands.

The alpha.2 suite had **204 passing tests**, including 15 focused start-workflow tests; the blank-session correction adds ownership protection and corrects the start fixture. They compose ordinary worker/supervisor roles with fake native sessions/Herdr, real owner/worker IPC and temporary records. Covered outcomes: blank start-only enrollment without a task; ordinary task submission without rearming; consumed input never exposing an old stop; sticky Escape/prompt/error/abort; same-nonce confirmed return; one-use delivery and two nudges despite growing history/repeated start; independent pauses; missing/cancelled/foreign/self/forged opt-ins; and checkpoint-write failure fencing stale evidence. The unresolved-decision case asserts that start sends no new turn or choice; it is not real-model judgment evidence.

An isolated Linux probe against installed Pi 1.5.0 and 1.5.2 uses actual native compaction/context-edit projections, verifies bookkeeping does not change checkpoint text, checks the native Escape helper and discovers/binds the packed normal extension with empty isolated auth paths and no model/Herdr request. The source payload contains 27 explicit files; tests/private/SDK resources remain excluded. These checks are not a live installation, a new real-model start-command trial, existing-worker migration or native Windows/macOS runtime acceptance.

## Focused Linux alpha trial

A fresh ordinary-extension trial on Linux with native Pi 1.5.2, Herdr 0.9.5
(protocol 22) and real worker/supervisor/coordinator models exercised the earlier
held-report failure. A deliberate initial completion attempt while held was
refused; explicit human Clear retained the same report/stop while preserving
independent pauses and budget/history. After separate activation, the same
supervisor model session reassessed current evidence and sent one completion
notice. Repeated events did not duplicate it. A subsequent undelegated choice
remained a decision after Clear; no choice or continuation was supplied.

Initial prompts and the protocol were fixed before launch, with no mid-trial
supervisor coaching. The model also corrected an absent-evidence refusal on its
own. This is one focused passing trial, not a general reliability guarantee or a
full repeat of P1–P7. Earlier competing-owner/restart and bounded-nudge checks
remain separate controlled/source evidence. Existing-worker migration, live
settings installation and platform runtime acceptance were not performed.

The alpha.1 release suite had 188 passing tests, including a native-command
lifecycle regression for held rejection followed by same-nonce reassessment,
bound-coordinator completion delivery and consequential refusal/dedup checks.

A later hands-on Linux trial passed completion and one approved two-stage native continuation, but same-decision reassessment after Clear did not cleanly pass: it reached the bounded unresolved-after-corrective-wake pause without a fresh disposition. No unsafe continuation occurred. That model limitation remains; the new start commands do not claim to fix it.

## Narrative and historical evidence

A prior independent blind model exercise selected acceptable dispositions for
12/12 synthetic cases spanning unfinished approved work, permission, ambiguity,
review follow-ups, whole-assignment completion, injection, abort and errors. It
used production attention/schema/evidence checking, not live effects or a semantic
proof. `node scripts/judgment.mjs --blind` supplies reviewer-only input;
`--check <answers.json>` validates answers. Ordinary tests do not call a model.

Earlier disposable Linux Pi/Herdr/scripted-model trials and three-OS isolated CI
are bounded historical evidence, not credentialed workflow or native macOS/Windows
runtime acceptance. Partial SDK/native-UI experiments and their detailed evidence
are preserved on [`experiment/sdk-host-native-ui-deferred`](https://github.com/fbl-vol/pi-continuation/tree/experiment/sdk-host-native-ui-deferred),
not accepted or part of ordinary package delivery. Retained historical tests do
not make SDK completeness, exhaustive dialogs, a fork or upstream agreement gates.

**Bounded held-report recovery (P3/P4/P7):** after resolving the hold reason and
explicit human Clear, only a current unchanged successful report produced while
held becomes available for supervisor reassessment, retaining its nonce/reply.
Identity, leaf, generation and current conversation must still match. Clear is
not action approval, scope activation, pause lifting or a budget reset. Existing
handled/resumed/intent/receipt guards still refuse consumed or ambiguous work;
stale, aborted/error and missing reports are not rearmed. Start-mode typing/Escape can park the same previously idle report for explicit return, without minting a nonce or bypassing any consumed-stop guard.
The regression fails on the prior unknown/null clear behavior. Ordinary lifecycle
tests cover raw input, a fresh held report, confirmation, independent scopes,
reassessment and one-use delivery. An isolated native Pi 1.5.0 probe verifies real
registered-command dispatch before the input event with fake UI/temporary session
state, without a model request or real Herdr connection. These are source checks,
not real-worker/user acceptance. macOS verification is deferred/not verified by
user decision, not a current acceptance blocker or passing platform evidence.

Model misreading, hidden/unreported UI and changes between process checks remain
limitations. Genuine approvals/pauses/review still cannot be bypassed. A new
weakness needs an actual baseline regression before becoming work; material
workflow/safety changes require the user's decision and smallest alternative.
