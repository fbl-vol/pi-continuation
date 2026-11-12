# Narrative judgment and UI boundary evidence

These are development observations, **not replacement acceptance**. The required approval boundary is unchanged.

## A: narrative checkpoint plus final reply

A blind read-only model exercise using `openai-codex/gpt-6-sol` selected acceptable dispositions for 12/12 synthetic stops. Cases cover unfinished approved work, explicit and implicit permission requests, conflicting checkpoint/reply evidence, review follow-ups, whole-assignment completion, blockers, ambiguity, historical quoted questions, injected instructions, aborts and provider errors. Expected outcomes were authored before the review and withheld from the reviewer.

The inputs use the production attention formatter and registered tool description/schema. The checker requires exactly one result per case, arguments valid against the registered tool schema, an independently permitted outcome, exact synthetic worker/stop identity, and acceptance by the production evidence/freshness policy. It performs no effects.

From a source checkout, repeat with a fresh independent reviewer:

```sh
node scripts/judgment.mjs --blind > /tmp/continuation-blind.json
# Give only that file to the reviewer; no fixture expectations or prior answers.
# Record [{"caseId":"case-1","arguments":{...}}, ...] without answer-key feedback.
node scripts/judgment.mjs --check /tmp/continuation-judgments.json
```

This exercises actual model interpretation, not a forced incorrect disposition. It is still a small, single-model, single-pass review, not the configured supervisor's complete native tool loop, long-running behavior, or a semantic safety proof. Ordinary `npm test` validates the offline harness and deterministic policy; it does **not** call a model or establish the 12-case behavioral result itself. A remains the chosen workflow. Mandatory structured worker declarations remain a proposed contingency, not an implemented protocol or an answer to UI ordering.

## Native Pi 1.5.2 TUI probe (Linux)

A disposable, ephemeral Pi process with discovery and tools disabled exercised real native dialogs. No workers were registered, no package settings were installed, and no model request was made by that probe.

| Interaction | Owned confirmation accepted | Holds signalled | Outer start events |
|---|---:|---:|---:|
| Uncontended owned confirmation | true | 0 | 1 |
| Shared-context input entirely inside it | false | 1 | 1 |
| Alternate shortcut-context input entirely inside it | **true** | **0** | 1 |

The new shared-UI guard observes `select`, `confirm`, `input`, `editor` and `custom` calls synchronously before native display. It fences registration consent, initial-message publication, hold clearing and receipt-time delivery. Closing an external dialog never clears the sticky worker hold. It also checks wrapper integrity and releases its wrappers on shutdown without overwriting a later extension's replacement.

**Known uncovered boundary:** native shortcut handlers receive a different UI object. Its prompt calls bypass both the shared-object wrappers and the runner's nested prompt events. An approval entirely inside an owned confirmation can therefore remain invisible. Loading this extension first is necessary for event ordering, but does not fix this context gap. These observations establish a remaining UI-observability failure, not a failed interpretation by A. Structured stop declarations would not repair it either.

No supported package-side all-context prompt mechanism has been established. Hooking private host state or broadly replacing terminal focus/rendering is not an equivalent verified boundary. Native macOS/Windows runtime, real supervisor/worker judgment, full prompt coverage, and separately authorized selected-worker installation/transfer/rollback remain unverified. Default-disabled activation and the prohibition on real-worker reliance remain in place.
