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

The new shared-UI guard observes `select`, `confirm`, `input`, `editor` and `custom` calls synchronously before native display. It fences registration consent, initial-message publication, hold clearing and receipt-time delivery. Closing an external dialog never clears the sticky worker hold. It also checks wrapper integrity and releases its wrappers on shutdown without overwriting a later extension's replacement. Once a check detects that a wrapper was replaced, that guard remains invalid even if the wrapper is put back. Detection signals the worker's durable hold and discards the old eligible stop; reload does not restore that stop. Isolated regressions reproduced both silent rearming and missing persistence before this correction. This is detection-time protection, not continuous observation of every UI assignment or a fix for the separate-context gap.

**Known uncovered boundary:** native shortcut handlers receive a different UI object. Its prompt calls bypass both the shared-object wrappers and the runner's nested prompt events. An approval entirely inside an owned confirmation can therefore remain invisible. Loading this extension first is necessary for event ordering, but does not fix this context gap. These observations establish a remaining UI-observability failure, not a failed interpretation by A. Structured stop declarations would not repair it either.

The standalone extension still has no supported all-context prompt mechanism. Hooking private host state or broadly replacing terminal focus/rendering is not an equivalent verified boundary. Native macOS/Windows runtime, real supervisor/worker judgment, full prompt coverage, and separately authorized selected-worker installation/transfer/rollback remain unverified. Default-disabled activation and the prohibition on real-worker reliance remain in place.

## SDK resource-boundary integration (not a delivered worker launcher)

The exported SDK resource loader accepts `extensionsOverride`. The new `createPromptScope()` helper can transform loaded shortcut definitions through that boundary, observing their separate UI contexts before each prompt call. It does not change Pi, intercept terminal output or use an unshipped host API. A caller must apply the override on every resource load and pass the same host-lifetime scope to `bindObservation`; the ordinary extension entry point does neither and gains no additional coverage.

In an isolated installed Pi 1.5.2 SDK test, real `InteractiveMode` shortcut dispatch/dialogs ran against a fake terminal transport. Alternate input and a pending-factory/hidden overlay were each exercised initially, after native session replacement, and after command-driven native reload. In all six scoped cases the package guard rejected the overlapping owned confirmation and signalled one hold, although the native owned dialog itself returned true. All six unscoped comparisons incorrectly accepted with no hold. The host snapshot capability was absent; no model runs, real workers or live configuration were used. This is SDK integration evidence, not physical-terminal or cross-platform runtime acceptance.

A second isolated SDK exercise used the production `bindObservation` workflow and a synthetic saved session/worker. It verified blocked registration on alternate-context overlap, a hold before any terminal input, durable reload restoration and rejection of an overlapping hold-clear using a shortcut context cached before reload. The unscoped comparison reproduced the missing protections. Both used fake terminal transport and temporary state, with no real Herdr connection or model runs.

Worker observations optionally pin the scope identity and revision. An unchanged scope preserves an eligible stop on restore; a different host, a stamp present on only one side, or activity during the unobserved reload gap instead durably holds the worker and discards that stop. This includes a scoped worker reopened without a scope. A review found that downgrade initially escaped the comparison; its regression failed before the symmetric comparison was applied. Closing a prompt or replacing the guard cannot clear the hold. Isolated production-observer tests cover registration publication, hold clearing and restoration; receipt-time checks share the same synchronous guard state.

A complete supported SDK launcher, native discovery/configuration parity, integrated supervisor workflow and whole-replacement acceptance are still required. This preparation does not adopt the local Pi patch or make the standalone extension safe for real-worker replacement.
