# Validation evidence and limits

[extension-parity.md](extension-parity.md), P1–P7, is the bounded acceptance set.
Tests/reviews verify it; they do not create requirements. Owner completion is not
user acceptance; whole-native-UI proof is not a hidden gate. No live installation,
real-worker migration, secrets or npm publication is implied.

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

**Unresolved recovery contract (P3/P4/P7):** after a user interaction and fresh
held report, current Clear hold deliberately writes unknown/null, so no eligible
stop remains without a later turn. Retaining that report for review would change
the explicit old-stop invalidation promise and is paused for the user's decision.
The ordinary candidate does not claim completed recovery parity or acceptance.

Model misreading, hidden/unreported UI and changes between process checks remain
limitations. Genuine approvals/pauses/review still cannot be bypassed. A new
weakness needs an actual baseline regression before becoming work; material
workflow/safety changes require the user's decision and smallest alternative.
