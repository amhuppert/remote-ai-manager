---
name: react-scan
description: Measure and diff React component render counts (especially unnecessary re-renders) in this app using react-scan + playwright-cli. Use when investigating re-render performance, validating that a perf change reduced renders, or auditing which components re-render during a specific user flow.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(bun:*) Bash(jq:*)
---

# react-scan + playwright-cli workflow

Measure per-component render events in this app's dev build, then diff before vs. after a perf change. The app exposes a structured buffer; Playwright reads it back as JSON; `jq` aggregates.

## Prerequisites

- Dev server running: `bun run dev` (default port 3000).
- The `ReactScanInstrumentation` component is already wired in `src/app/layout.tsx`. It is dev-only — it does nothing in production builds.
- `playwright-cli` available (see the `playwright-cli` skill).

## What the app exposes

In dev only, the page sets up two window globals:

| Global | Type | Purpose |
|---|---|---|
| `window.__reactScanReport` | `ReactScanRenderEntry[]` | append-only buffer of every render event since the last reset |
| `window.__reactScanReset()` | `() => void` | clear the buffer; call before a flow you want to measure |

Each entry:

```ts
{
  component: string;       // function/displayName, or "Anonymous"/"Unknown"
  count: number;           // renders bippy attributes to this commit
  unnecessary: boolean;    // react-scan's verdict: same output, wasted work
  timeMs: number;          // commit time attributed to this render
  phase: "mount" | "update" | "unmount";
  at: number;              // performance.now() when the event was recorded
}
```

## The loop

1. **Open** the page you want to measure and let it settle:
   ```bash
   playwright-cli open http://localhost:3000/projects/<name>/<session>/<conversationId>
   playwright-cli wait-for 500   # let initial mount settle
   ```
2. **Reset** the buffer right before the flow:
   ```bash
   playwright-cli eval "window.__reactScanReset()"
   ```
3. **Perform** the flow. Use `playwright-cli type`, `click`, `press`, etc.
4. **Capture** the buffer:
   ```bash
   playwright-cli --raw eval "JSON.stringify(window.__reactScanReport)" > /tmp/scan.json
   ```
5. **Analyze**. See aggregations below.

## Aggregations (jq)

Top components by render count:

```bash
jq 'group_by(.component)
    | map({component: .[0].component,
           total: length,
           unnecessary: (map(select(.unnecessary)) | length),
           totalMs: (map(.timeMs) | add)})
    | sort_by(-.total) | .[0:15]' /tmp/scan.json
```

Top "unnecessary" offenders:

```bash
jq '[.[] | select(.unnecessary)]
    | group_by(.component)
    | map({component: .[0].component, unnecessary: length})
    | sort_by(-.unnecessary) | .[0:15]' /tmp/scan.json
```

Totals:

```bash
jq '{events: length,
     unnecessary: ([.[] | select(.unnecessary)] | length),
     components: ([.[].component] | unique | length)}' /tmp/scan.json
```

## Before/after comparison

Validate a perf change by capturing the **same flow** on two commits.

```bash
# Capture BEFORE
git switch main
# (restart dev server if running, so HMR doesn't keep prior module state)
playwright-cli open http://localhost:3000/<route>
playwright-cli wait-for 500
playwright-cli eval "window.__reactScanReset()"
# … perform the exact flow …
playwright-cli --raw eval "JSON.stringify(window.__reactScanReport)" > /tmp/before.json

# Capture AFTER
git switch perf-branch
# restart dev server, repeat the EXACT same flow
playwright-cli --raw eval "JSON.stringify(window.__reactScanReport)" > /tmp/after.json
```

Diff per component:

```bash
jq -s '
  def agg: group_by(.component) | map({
    component: .[0].component,
    total: length,
    unnecessary: (map(select(.unnecessary)) | length)
  }) | INDEX(.component);

  (.[0] | agg) as $b | (.[1] | agg) as $a
  | (($b | keys) + ($a | keys) | unique)
  | map({
      component: .,
      before: ($b[.].total // 0),
      after:  ($a[.].total // 0),
      delta:  (($a[.].total // 0) - ($b[.].total // 0)),
      unnecessary_before: ($b[.].unnecessary // 0),
      unnecessary_after:  ($a[.].unnecessary // 0)
    })
  | sort_by(.delta)
' /tmp/before.json /tmp/after.json
```

Accept the change only if:
- Target components drop by ≥10% in `total` (or `unnecessary` drops meaningfully).
- No unrelated component regresses by >10% in either column.

Single runs vary; **run 3 times and take the median** per flow.

## Common flows in this app

- **Typing in the prompt** — focus the prompt editor, type ~20 characters. Each keystroke cascades through the conversation page.
  ```bash
  playwright-cli click "[contenteditable='true']"
  playwright-cli type "hello world this is a test prompt"
  ```
- **Streaming response** — submit a prompt; while the assistant streams, the optimistic-message store fires per chunk. Wait ~5–10s with the conversation in "running" state.
- **Conversation switch** — click a different conversation in the sidebar; measures conversation-mount cost.
- **Idle polling** — leave the page on a busy conversation for ~10s while `messagesQuery` polls (3s interval).

## Gotchas

- **Initial mount noise.** The first 100–500ms after `playwright-cli open` records every mount in the tree. Always `__reactScanReset()` *after* the page settles, immediately before the flow.
- **Toolbar is off.** The visual react-scan overlay is hidden in this instrumentation on purpose (it interferes with screenshots/snapshots and accessibility tree). For visual inspection during human debugging, run `npx react-scan@latest http://localhost:3000` in a side terminal — it injects a separate instance into a fresh browser.
- **Anonymous components** appear as `"Anonymous"` or `"Unknown"`. Set `displayName` or use a named function declaration to disambiguate.
- **Production builds skip instrumentation.** The component is gated on `process.env.NODE_ENV === "development"` and never sets the window globals in prod. If `window.__reactScanReport` is `undefined`, you're on a prod build — switch to `bun run dev`.
- **HMR.** Hot reloads do not re-initialise react-scan (guarded by the `__reactScanReport !== undefined` check). If `__reactScanReset` is missing after a code change, do a full `playwright-cli reload`.
- **Phase as string.** The buffer stores `phase` as `"mount" | "update" | "unmount"` even though react-scan internally uses a numeric enum. Don't compare against numbers.
- **Don't trust totalMs across runs.** Commit-time attribution varies with CPU load; use it as a relative signal within one run, not absolute.

## Source

- Instrumentation component: `src/components/ReactScanInstrumentation.tsx`
- Mounted in: `src/app/layout.tsx`
