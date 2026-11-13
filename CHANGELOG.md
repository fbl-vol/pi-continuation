# Changelog

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
