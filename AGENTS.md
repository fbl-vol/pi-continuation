# pi-continuation contributor guide

This is a public, personal project owned by `fbl-vol`, separate from any employer
or customer repository. Read README.md for current implementation status.

- Keep the public source generic. Never copy private skills, project instructions,
  checkpoints, session records, credentials, machine configuration, or customer
  details into this repository or its Git history.
- Work in the primary checkout; do not create or enter worktrees unless the user
  explicitly requests them. Preserve unrelated changes.
- Before non-trivial implementation, resolve this repository's knowledge-base
  mapping through the available machine-local resolver. An absent mapping is not
  permission to import another project's guidance. Use this guide and current
  Pi/Herdr documentation and source instead; report material gaps.
- Read the relevant installed Pi documentation and current Herdr API contracts
  before implementing integrations. Prefer native lifecycle, persistence,
  identity, and messaging mechanisms over shell polling or duplicated state.
- Treat cross-platform support as a tested claim. Avoid assumptions about shells,
  path syntax, systemd, or other platform-specific services.
- Deterministic code owns eligibility, identity, deduplication, pauses, and bounds;
  model judgment owns interpretation of task evidence, not new user authority.
- Keep one continuation owner per worker. Never bypass genuine approval requests,
  user pauses, or independent review and acceptance requirements.
- Use isolated tests with fake sessions/transports and temporary state. Never
  prompt live workers or alter existing supervision as a side effect of tests.
- Review the final diff and npm package payload before Git publication. Keep
  package resources and published files explicit; never auto-load test files.
- Creating a public repository does not authorize npm publication, installation
  into live Pi settings, live worker registration, or migration of supervisors.
  Those actions need their own explicit scoped instruction.
