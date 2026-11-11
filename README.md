# pi-continuation

Explicit, bounded continuation supervision for [Pi](https://pi.dev) workers in
[Herdr](https://github.com/herdrdev/herdr).

**Status: package scaffold only.** There are no extension entrypoints, commands,
worker registration, or automatic continuation yet. Nothing in this repository
replaces an existing supervisor installation today.

## Goal

Keep explicitly assigned work moving across Herdr workspaces without external
OS-specific scheduling or a second task-management system. Reuse Pi's native
lifecycle and persistence mechanisms and Herdr's supported session and messaging
interfaces wherever possible.

The intended shape is one package with worker and supervisor roles:

- Workers report lifecycle facts and receive permitted continuation.
- One supervisor tracks unresolved stops, decides whether approved work remains,
  and routes material blockers or decisions to the user.
- Workers retain ownership of their existing tasks and checkpoints.

The exact transport and role-loading design still needs API investigation.
Windows, Linux, and macOS are target platforms, not verified support claims.

## Safety boundaries

- Register exact sessions explicitly; never infer authorization from pane names.
- Preserve independent global, workspace, and worker pauses.
- Do not continue past a genuine approval request or user stop.
- Bound continuations without meaningful progress; escalate rather than loop.
- Keep wake delivery separate from acknowledgement and task acceptance.
- Allow only one continuation owner per worker.
- Persist unresolved attention and reconcile on startup without automatically
  rebinding replaced sessions or lifting pauses.
- Do not continue workers automatically while the supervisor is unavailable.
- Do not launch workers, deploy software, or grant project permissions implicitly.

## Local package development

Pi can load a package from an absolute local directory without npm publication:

```sh
pi install /absolute/path/to/pi-continuation
```

This command changes your Pi package settings. It is shown for future use, not
required now: the scaffold declares an empty extension list and adds no runtime
behavior. Development has not installed or enabled this package automatically.

Inspect the future npm payload without publishing:

```sh
npm pack --dry-run
```

No runtime dependencies or build step are required for this scaffold.

## Distribution

The GitHub repository is owned by the personal account **fbl-vol**, not an
organization. Source is MIT licensed.

The planned npm name is `@fbl-vol/pi-continuation`. GitHub ownership does not
establish npm scope ownership; npm account access and name availability must be
verified before publishing. The package is deliberately marked `private: true`
to prevent accidental publication while it is only a scaffold.

A future release can declare its tested extension entrypoints, include source in
an explicit package file allowlist, and remove the private guard as part of an
explicitly approved npm publication. The `pi-package` keyword prepares the
manifest for Pi package gallery discovery after publication; no gallery listing
or npm release exists yet.
