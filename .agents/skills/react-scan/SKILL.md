---
name: react-scan
description: Measure and diff React component render counts (especially
  unnecessary re-renders) in this app using react-scan + playwright-cli. Use
  when investigating re-render performance, validating that a perf change
  reduced renders, or auditing which components re-render during a specific user
  flow.
---

# react-scan + playwright-cli workflow

Measure per-component render events in this app's dev build, then diff before vs. after a perf change. The app exposes a structured buffer; Playwright reads it back as JSON; `jq` aggregates.

## Prerequisites

- Dev server running: `cctl dev ensure` (starts it if needed and prints the session-scoped `localUrl` — use that, not an assumed port like 3000).
- The `ReactScanInstrumentation` component is already wired in `src/features/_root/RootLayout.tsx`. It is dev-only — it does nothing in production builds.
- Add `scan=1` to the target URL (`?scan=1` or `&scan=1` after existing query parameters). Instrumentation is opt-in and initializes on page load, so reload after adding the parameter.
- `playwright-cli` available (see the `playwright-cli` skill). Use a named browser session owned by this task.

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
  phase: string;          // mount/update/unmount, or an unknown phase label
  at: number;              // performance.now() when the event was recorded
}
```

## The loop

1. **Open** the page you want to measure and let it settle:
   ```bash
   playwright-cli -s=reactscan open "<localUrl>/conversations?c=<conversationId>&scan=1"
   playwright-cli -s=reactscan run-code "async page => { await page.getByTestId('prompt-input').waitFor(); await page.waitForFunction(() => typeof window.__reactScanReset === 'function'); }"
   ```
2. **Reset** the buffer right before the flow:
   ```bash
   playwright-cli -s=reactscan eval "window.__reactScanReset()"
   ```
3. **Perform** the flow using the same `-s=reactscan` session for `type`, `click`, `press`, or `run-code`.
4. **Capture** the buffer:
   ```bash
   playwright-cli -s=reactscan --raw eval "JSON.stringify(window.__reactScanReport)" > .cc/temp/scan.json
   ```
5. **Analyze**. See aggregations below.

## Aggregations (jq)

Top components by render count:

```bash
jq 'group_by(.component)
    | map({component: .[0].component,
           events: length,
           total: (map(.count) | add),
           unnecessary: (map(select(.unnecessary)) | length),
           totalMs: (map(.timeMs) | add)})
    | sort_by(-.total) | .[0:15]' .cc/temp/scan.json
```

Top "unnecessary" offenders:

```bash
jq '[.[] | select(.unnecessary)]
    | group_by(.component)
    | map({component: .[0].component, unnecessary: length})
    | sort_by(-.unnecessary) | .[0:15]' .cc/temp/scan.json
```

Totals:

```bash
jq '{events: length,
     unnecessary: ([.[] | select(.unnecessary)] | length),
     components: ([.[].component] | unique | length)}' .cc/temp/scan.json
```

## Before/after comparison

Capture a baseline **before editing** in the assigned worktree, then repeat the same flow after the change. Keep the route, fixture data, viewport, and scan activation identical; reload to remove HMR state. Save both results under `.cc/temp/` in this worktree.

If the change is already present and no baseline was captured, report that limit. Use `git show`/`git diff` for source comparison; do not switch the CC-managed branch or operate on the main worktree to manufacture a baseline.

```bash
# Before the edit, after the measured flow:
playwright-cli -s=reactscan --raw eval "JSON.stringify(window.__reactScanReport)" > .cc/temp/scan-before.json
# After the edit, reload, reset, repeat the same flow, then capture:
playwright-cli -s=reactscan --raw eval "JSON.stringify(window.__reactScanReport)" > .cc/temp/scan-after.json
```

Diff per component:

```bash
jq -s '
  def agg: group_by(.component) | map({
    component: .[0].component,
    total: (map(.count) | add),
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
' .cc/temp/scan-before.json .cc/temp/scan-after.json
```

Judge the result against the requested performance goal or an established budget. Report render counts and material regressions; a universal percentage threshold cannot establish usefulness. Repeat equivalent runs when noise prevents a conclusion, comparing medians if needed. Stop when the evidence is sufficient for the claim.

## Common flows in this app

- **Typing in the prompt** — focus the prompt editor, type ~20 characters. Each keystroke cascades through the conversation page.
  ```bash
  playwright-cli -s=reactscan click "[contenteditable='true']"
  playwright-cli -s=reactscan type "hello world this is a test prompt"
  ```
- **Streaming response** — submit a prompt; while the assistant streams, the optimistic-message store fires per chunk. Wait ~5–10s with the conversation in "running" state.
- **Conversation switch** — click a different conversation in the sidebar; measures conversation-mount cost.
- **Idle activity** — measure a bounded interval in a known conversation state; inspect the current query/SSE behavior rather than assuming a polling frequency.

## Gotchas

- **Initial mount noise.** The first 100–500ms after `playwright-cli open` records every mount in the tree. Always `__reactScanReset()` *after* the page settles, immediately before the flow.
- **Toolbar is off.** The visual react-scan overlay is hidden in this instrumentation on purpose (it interferes with screenshots/snapshots and accessibility tree). For visual inspection during human debugging, run `npx react-scan@latest <localUrl>` in a side terminal — it injects a separate instance into a fresh browser.
- **Anonymous components** appear as `"Anonymous"` or `"Unknown"`. Set `displayName` or use a named function declaration to disambiguate.
- **Production builds skip instrumentation.** The component runs only in development/test and requires `scan=1`. If `window.__reactScanReport` is undefined, check the build mode, query parameter, and module-load errors before concluding which condition failed.
- **HMR.** Hot reloads do not re-initialise react-scan (guarded by the `__reactScanReport !== undefined` check). If `__reactScanReset` is missing after a code change, do a full `playwright-cli reload`.
- **Phase as string.** Known numeric phases become `mount`, `update`, or `unmount`; unknown values become strings. Do not compare against numbers.
- **Don't trust totalMs across runs.** Commit-time attribution varies with CPU load; use it as a relative signal within one run, not absolute.

## Source

- Instrumentation component: `src/components/ReactScanInstrumentation.tsx`
- Mounted in: `src/features/_root/RootLayout.tsx`

Close the task-owned browser when finished: `playwright-cli -s=reactscan close`.
