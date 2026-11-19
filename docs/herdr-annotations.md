# Herdr supervision annotations (since v0.3.0)

The ordinary extension can add compact supervision labels to Herdr's existing
Agents rows and counts to Spaces. Herdr still owns navigation and working/idle/
blocked activity. These labels are **display-only**, never permission to continue.
No additional plugin, dashboard or service is needed.

## One-time sidebar setup

For an already installed v0.3.0 or newer extension, merge the following rows into your Herdr
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

## Delegated role labels

New delegated sessions get a compact initial pane label and a friendly `agent`
row such as `Owner · W123` or `Writer · W123`. Generic read-only delegates show
`Read-only`, not `Reviewer`. All roles in a grant use the same suffix: a unique
recognizable task code (for example `W123` or `W123-D04`), a short checkout name
when available, or no suffix. The assignment text is not sent to Herdr as
metadata. The internal `pc-…` launch name is unchanged.

After dispatch, the extension checks the new pane's current session and only
attempts to name it if it is still unlabeled. It never retries the rename or
renames on refresh; existing and later manual labels remain visible on Herdr's
pane surfaces. Herdr 0.9.5 cannot make the check and rename atomic. The separate
`agent` row uses expiring display metadata for the exact enrolled session. Stop,
loss or replacement withdraw that metadata without renaming the pane. Role,
native activity and supervision status are separate; if optional labeling fails,
startup and delivery are unaffected. Existing sessions are not backfilled.

## Meaning and lifetime

- `Supervised` means registered in the active supervision list, **not** that the
  next turn is eligible or an approval has been granted.
- `Paused`, `Paused: global` and `Paused: workspace` preserve separate scopes.
  `Held: prompt`, `Held: decision`, `Held: error` and `Held: delivery` describe
  existing deterministic state. Since v0.3.3, newly recorded failed Pi
  turns show `Held: run failed`; checkpoint-write failures show `Held: checkpoint`.
  Details explains the cause, hold-recorded time and confirmed recovery control.
  Old unclassified error holds remain `Held: error`, with cause/time unavailable;
  they are not silently cleared or guessed to be run failures. Intermediate tool
  failures no longer create a hold by themselves in this version, but real
  failed turns, prompts and existing holds remain protected. Published v0.3.2
  retains the earlier tool-error behavior. No prose classifier invents authority.
- A verified supervisor has `Supervisor` or `Supervisor: paused`. Without an
  initial pinnable native path identity, the supervisor receives no badge and its
  annotation source publishes no worker badges or workspace counts either.
  This disables only display reporting, not supervisor startup or continuation
  authority. Loss of a verified owner withdraws that source's annotations.
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
mutate supervision state. The reporter does not change pane labels or titles,
native agent lifecycle/activity, or other sources' presentation. Control failures
remain control failures.

## Evidence limits

The API/configuration baseline is Herdr 0.9.5, protocol 22. Isolated tests cover
the adapter and ordinary extension lifecycle with fake Pi/Herdr transports and
temporary state. An earlier disposable Linux native rendering check established
custom-row elision, compact narrow labels, token colors, stale-sequence rejection
and TTL expiry; it was not a live trial of this adapter. Current-adapter native,
real-model and Windows/macOS runtime acceptance are not claimed. See
[validation](validation.md) and the bounded [parity scenarios](extension-parity.md).
