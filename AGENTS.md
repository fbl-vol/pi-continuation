# pi-continuation contributor guide

This is a public, personal project owned by `fbl-vol`, separate from any employer
or customer repository. Read README.md for current implementation status.

## Repository-scoped delivery autonomy

The user explicitly authorizes agents assigned to this project to implement the
agreed scope, start independent read-only reviews, evaluate and fix in-scope review
findings, rerun validation, create coherent commits, and push code to the personal
GitHub repository `fbl-vol/pi-continuation` without asking again for each step.
They may create task branches and pull requests as part of this delivery. Keep one
implementation writer; review agents must not edit source or delegate further.
The implementation owner coordinates review, finding dispositions, verification,
and GitHub delivery. Record the reviewed revision, material findings and their
dispositions, checks, and remaining evidence gaps. Self-review is not independent
review. Do not bypass failing hooks/checks, force-push, or auto-merge.

This autonomy does not authorize npm publication, live package installation,
worker registration or migration of existing supervisors, deployments, secret
access, worktrees, unrelated repositories, or a material change to the agreed
product/safety contract. Those actions retain their separate scoped approval
requirements. Cross-platform support must reflect actual verification, not only
mocked tests.

## Engineering boundaries

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
