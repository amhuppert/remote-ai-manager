# Conversation Page Perf Investigation — 2026-05-17

Branch: `cc/conversation-page-performance-9cced1`. Target page: `/projects/[name]/[session]/...` (conversation detail / recap).

## What was tried

Implementation plan called for four interventions:

1. `React.lazy()` + `Suspense` around `ConversationVirtuosoList` in `ConversationDetailPage.tsx`.
2. `React.lazy()` + `Suspense` around `MarkdownContent` in three consumers (`MessageContent.tsx`, `CommandIndicator.tsx`, `collab/CollabFinalAnswerMessage.tsx`).
3. `React.lazy()` + `Suspense` around `ConversationSidebar` and `MobileInfoPanel` in `ConversationDetailPage.tsx`.
4. Remove redundant `refetchInterval: 10_000` from `useSessionsQuery`, `useSessionQuery`, `useActiveConversationsQuery` in `src/lib/queries.ts` (SSE already invalidates `sessionKeys.all`, which is the parent of `sessionKeys.detail`).

Acceptance target: ≥10% LCP improvement on the conversation detail page under pinned emulation.

## Methodology

- Pinned emulation: 4× CPU throttle, Slow 4G, 390×844×2 mobile viewport, cache-cold tab per run (close + new_page + emulate + navigate + trace-with-reload).
- Prod build (`env -u NODE_ENV bunx next build` + `next start -p 3002`). Dev mode is not a valid comparison because Turbopack does not code-split for HMR — lazy() has no payload benefit there and just adds round-trips.
- N=3+ runs medianed per condition. Both conditions measured against the **same** production build pipeline so the comparison is apples-to-apples.

## Results

Prod cold-load LCP, same URL, same emulation:

| Run | BEFORE (no lazy) | AFTER (lazy + Suspense) |
|----:|-----------------:|------------------------:|
| 1   | 4,006 ms          | 3,017 ms                |
| 2   | 6,003 ms          | 6,002 ms                |
| 3   | 5,900 ms          | 6,001 ms                |
| 4   | —                 | 6,315 ms                |
| 5   | —                 | 6,003 ms                |
| **Median** | **5,900 ms** | **6,002 ms**       |

Delta: **−1.7%** (AFTER is marginally worse, well inside noise). Acceptance criterion **not met**.

Notes on the data:
- Both conditions show a first-run outlier (~3–4 s) then cluster tightly at ~6,000 ms. The ceiling is environmental (likely `autoStop` cutoff in chrome-devtools-mcp or a stable hydration cliff under Slow 4G), not code-related. Re-running the same condition reproduces the cluster, so the comparison is valid even though the absolute numbers feel suspiciously round.
- LCP element is `topbar-logo` (text near top of page, nodeId varies 27–32). TTFB is ~10 ms; **>99% of LCP is render delay** — i.e. hydration-blocking JS, not network or document latency.

## Root cause of unmoved LCP

The LCP element is rendered by `Topbar` / `Providers`, *not* by anything inside the conversation page. The critical path to first paint is:

```
HTML → framework chunk → Providers (QueryClient init) → Topbar → first paint
```

Code-splitting page-internal components (sidebar, virtuoso list, markdown viewers) does not shorten this path. Those chunks are not loaded synchronously on initial render, so excluding them from the initial bundle does not reduce the JS that has to parse + evaluate before Topbar can paint. On Slow 4G, adding more chunks actually adds round-trips, which is consistent with the slight regression observed.

## What was kept vs reverted

**Kept** (in `src/lib/queries.ts`):
- Removal of `refetchInterval: 10_000` from `useSessionsQuery`, `useSessionQuery`, `useActiveConversationsQuery`. These polls are redundant — SSE invalidation on `sessionKeys.all` covers all session detail queries. No LCP benefit, but reduces background CPU/network/battery cost. Kept because it's correct independent of perf goals.

**Reverted** (4 files):
- `src/components/MessageContent.tsx` — `MarkdownContent` back to direct import.
- `src/components/CommandIndicator.tsx` — `MarkdownContent` back to direct import.
- `src/app/projects/[name]/[session]/collab/CollabFinalAnswerMessage.tsx` — `MarkdownContent` back to direct import.
- `src/app/projects/[name]/[session]/ConversationDetailPage.tsx` — `ConversationVirtuosoList`, `ConversationSidebar`, `MobileInfoPanel` back to direct imports; `VirtuosoFallback` helper deleted; `Suspense` wrappers removed for those three components. The pre-existing `PromptEditor` lazy() at line 105 was left untouched (predates this branch).

**Pre-existing and preserved** (not touched by this revert):
- `src/components/ReactScanInstrumentation.tsx` — dev-only render instrumentation (guarded by `process.env.NODE_ENV === "development"`).
- `.claude/skills/react-scan/SKILL.md` — usage skill.
- `src/app/layout.tsx` — `<ReactScanInstrumentation />` mount.
- `package.json` / `bun.lock` — `react-scan: ^0.5.6` dependency.

## Side-effects of the lazy() approach (additional reasons to avoid)

- 2 jsdom test regressions in `ConversationDetailPage.test.tsx` — synchronous `screen.getByText(...)` does not reliably see Suspense fallback text in React 19 + jsdom even though the fallback DOM contains it. Switching consumers to `findByText` everywhere they exercise markdown would be required, multiplying maintenance cost.
- More chunks → more HTTP round-trips on slow networks (consistent with the −1.7% prod delta).

## For future investigators

If you're trying to reduce conversation-page LCP, **do not** start with code-splitting page-internal components — that path is empirically disproved. Look upstream:

1. **Providers / QueryClient hydration cost** — `Providers.tsx` runs `useState(makeQueryClient)` on first render. Profile whether the QueryClient construction or any provider tree is the long pole.
2. **Topbar render path** — since the LCP element is `topbar-logo`, anything that delays Topbar's first commit is on the critical path. Check whether Topbar is gated on any async data or hydration step it shouldn't be.
3. **Framework chunk size** — Next.js 16 framework chunk + React 19 + the always-loaded layout providers. Run `DuplicatedJavaScript` and `LegacyJavaScript` insights against the prod build.
4. **`LongCriticalNetworkTree` / `NetworkDependencyTree`** — the render-delay-dominated LCP suggests something is blocking that isn't surfaced in our analysis so far.
5. **Streaming SSR opportunities** — currently the full RSC tree is awaited before any paint. Splitting Topbar into its own streaming boundary might let it paint before the conversation tree is ready.

Traces from this investigation are in `/tmp/perf-traces/` (`prod-before-cold-run{1..3}.json.gz`, `prod-after-cold-run{1..5}.json.gz`). They will be cleaned at OS reboot — capture fresh ones rather than relying on these.

## Process notes (lessons for next time)

- The original BEFORE baseline (5,233 ms) referenced in the plan was a **dev-mode** measurement. Comparing dev BEFORE to prod AFTER is invalid — Turbopack does not code-split in dev. Always measure both conditions in the **same** build mode the change will ship in.
- A `next build` failure that traces to `Providers.tsx:26 useState(makeQueryClient) === null` is almost always caused by `NODE_ENV=development` leaking into the build environment. Run with `env -u NODE_ENV bunx next build`. Don't suspect Next.js / Turbopack framework bugs first.
- `chrome-devtools-mcp` `autoStop: true` traces appear to cluster around ~6,000 ms for LCP measurements on this page under the pinned emulation. If you see suspicious round numbers, capture with `autoStop: false` and manually stop after observing the LCP event.
