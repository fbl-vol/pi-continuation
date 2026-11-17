# Herdr supervision annotations (unreleased source)

The ordinary extension can add compact supervision labels to Herdr's existing
Agents rows and counts to Spaces. Herdr still owns navigation and working/idle/
blocked activity. These labels are **display-only**, never permission to continue.
No additional plugin, dashboard or service is needed.

## One-time sidebar setup

For an already installed source build, merge the following rows into your Herdr
configuration using Herdr's normal configuration/reload workflow. Applying this
example changes your profile and is a separate explicit action; the extension
never edits configuration or installs itself.

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [
    { token = "$pi_continuation_active", fg = "#a6e3a1" },
    { token = "$pi_continuation_attention", fg = "#f9e2af" },
    { token = "$pi_continuation_paused", fg = "#9399b2" },
  ],
]

[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status"],
  ["$pi_continuation_summary"],
]
```

These are the default native rows with one additional annotation row. Preserve
any existing custom rows rather than replacing your configuration wholesale; do
not duplicate existing TOML tables. If `ui.sidebar.agents.rows_by_agent.pi` is
configured, amend that override instead: it replaces the default rows for Pi.
For an unstyled single-token alternative, use `["$pi_continuation"]` as the extra
Agents row. Herdr 0.9.5 elides custom rows whose values are absent, so ordinary
unreported agents keep their native rows. Collapsed views and narrow sidebars may
not show all details; use Pi's `/continuation` menu for the explanation.

## Meaning and lifetime

- `Supervised` means registered in the active supervision list, **not** that the
  next turn is eligible or an approval has been granted.
- `Paused`, `Paused: global` and `Paused: workspace` preserve separate scopes.
  `Held: prompt`, `Held: decision`, `Held: error` and `Held: delivery` describe
  existing deterministic state. No prose classifier invents new authority.
- A verified supervisor has `Supervisor` or `Supervisor: paused`. A supervisor
  without a pinnable native path identity receives no badge.
- Spaces counts only verified, non-stopped worker bindings in that workspace,
  with a compact held/paused/unknown count when applicable. It is a separate
  workspace report, not an aggregation of native activity.
- Stop withdraws the worker's annotation and active-list count; explicit own-
  session Return restores reporting without changing the retained pauses/history.
  Missing or invalid observations show `Status unknown`, not an active badge.

The existing owner publishes namespaced pane/workspace tokens with a stable
owner-scoped source and increasing sequence. It reuses the existing subscribed
snapshots, renews at most every five seconds when unchanged, and requests a
15-second TTL. Changed state can publish sooner. Known replacement/removal,
subscription/owner loss and shutdown withdraw that source's tokens; expiry is the
fallback after crashes, unreachable targets or lost responses. Native metadata
has no atomic session-identity precondition: near-publication checks and expiry
bound display freshness, not eligibility. Absence of a badge proves only that no
current annotation is visible—not that no other supervisor exists.

Metadata failures are reported separately and do not activate, pause, resume or
mutate supervision state. Pane titles, native agent lifecycle/activity and other
sources' metadata are not overwritten. Control failures remain control failures.

## Evidence limits

The API/configuration baseline is Herdr 0.9.5, protocol 22. Isolated tests cover
the adapter and ordinary extension lifecycle with fake Pi/Herdr transports and
temporary state. An earlier disposable Linux native rendering check established
custom-row elision, compact narrow labels, token colors, stale-sequence rejection
and TTL expiry; it was not a live trial of this adapter. Current-adapter native,
real-model and Windows/macOS runtime acceptance are not claimed. See
[validation](validation.md) and the bounded [parity scenarios](extension-parity.md).
