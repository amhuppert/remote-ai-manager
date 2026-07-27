# Native SDD deep-link audit — ticket command-center#22

Date: 2026-07-24
Scope: every in-page link on the native SDD (Spec Studio) surfaces.

## The reported defect

On the spec History surface, "Open subject →" writes `?el=<handle>` to the URL and
nothing else happens.

Reproduced against the running app (`/specs/command-center/project-conversation-parity`):

1. Open the spec, click the **History** tab.
2. Click "Open subject →" on `Q4`. URL becomes `?el=Q4`, the Questions surface opens. Correct.
3. Click "Back to project-conversation-parity", then the **History** tab again.
4. Click "Open subject →" on `Q3`. URL becomes `?el=Q3` — **the surface stays on History.**

## Root cause

The active surface had two owners.

`SpecDetailPage` derived a view from the URL (`?view=`, or `?el=`'s element kind) and
passed it to `SpecDetailViews` as `initialView`. `SpecDetailViews` held the live value in
`useState` and reconciled the two by comparing *the derived value against the previously
derived value*:

```ts
const [view, setView] = useState<DetailView>(initialView);
const [syncedInitialView, setSyncedInitialView] = useState(initialView);
if (initialView !== syncedInitialView) {
  setSyncedInitialView(initialView);
  setView(initialView);          // only fires when the DERIVED value changes
}
```

Tab clicks and the "Back to <slug>" controls called `setView` without touching the URL, so
local state drifted from the address bar. After that drift, any link whose derived view
equalled the last-synced value was a complete no-op:

- `?el=Q4` → `?el=Q3`: both derive `questions`, so the guard never fires (the reported bug).
- `?view=history` (local) → `?el=R1`: `R1` derives `overview`, which was already the synced
  value, so a history row pointing at a requirement/decision/task/criterion never opened either.

The URL always changed; only the UI's decision to read it was conditional.

## Fix

The URL is now the single owner of the active surface.

- `SpecDetailViews` takes `view` / `onViewChange` instead of `initialView`; the local state
  and the `syncedInitialView` reconciliation are gone.
- `SpecDetailPage` derives `view` from `useSearchParams()` on every render and implements
  `onViewChange` as `router.replace(...)` — tab selections and back controls write
  `?view=<surface>` (or the bare detail path for `overview`) instead of a state slot.
- `TraceabilityGraph`'s `onOpenElement` compensation (`() => setView("overview")`) is deleted;
  its "Open <handle>" link now works because the URL drives the surface. The prop had no other
  caller and was removed. Its `spec_studio.trace.element_opened` log is unchanged.

`replace` (not `push`) keeps surface switching out of the browser back stack, matching how
the tabs behaved before they became addressable.

### User-visible consequence

Selecting a tab now writes the URL, so the History/Traceability surfaces are shareable,
reloadable, and survive a refresh. Previously a reload always dropped back to Overview.

## Feature-wide link audit

Every link that can navigate without remounting the spec detail page, and its status
after the fix.

| # | Link | Target | Before | After |
|---|------|--------|--------|-------|
| 1 | History "Open subject →" (`SpecHistoryPanel`) | `?el=<handle>` | **Broken** whenever the derived surface matched the last-synced one | Works |
| 2 | Traceability inspector "Open <handle>" (`SpecEvidenceLintTrace`) | `?el=<handle>` | Worked only via an explicit `setView("overview")` compensation | Works from the URL |
| 3 | Traceability node screen-reader link | `?el=<handle>` | **Broken** when traceability was reached by clicking the tab — it carries no compensation | Works |
| 4 | Lint panel "· Open element" | `?el=<handle>` | Worked (`lint` ≠ derived view) | Works |
| 5 | Overview inline-lint finding | `?el=<handle>` / `?view=lint` | Worked (already on overview) | Works |
| 6 | Header "Gate policy" / "Verify" / gate-preset chip | `?view=controls#…` | Worked | Works |
| 7 | Header primary action (Review revision / Open evidence / Open gate policy) | `?view=review\|evidence\|controls` | Worked | Works |
| 8 | Controls "← <slug>" and execution "Request changes" | bare detail path | Worked | Works |
| 9 | Review mode "← <slug>" | bare detail path | Worked | Works |
| 10 | Review mode change deep link | `?el=<handle>` or `?view=review&change=<id>` | Worked (review mode reads the URL directly) | Works |
| 11 | Inventory row "Gate policy" | `?el=execution_start` | Worked (cross-page mount) | Works |
| 12 | Cross-feature entries (`specStudioHref`, active-work rail, ticket spec cards) | detail path ± `?el=` | Worked (cross-page mount) | Works |

Rows 1 and 3 were live-broken. Row 2 only worked because of a local workaround that has
now been deleted in favour of the URL.

### Surfaces checked and found clean

- `SpecsPage` derives the selected project purely from `?project=` — no shadow state.
- `SpecReviewMode` reads `?change=` straight from props on every render.
- Local UI state that is *not* URL-derived and has no link pointing at it: the history
  filter chips, the traceability focus/selected node, the evidence filter, the inventory
  phase filter, and the controls rename field. These are the same shape as the defect but
  are not reachable by a link, so they are safe today.

## Known residual (not fixed)

Clicking a link whose href is byte-identical to the current URL performs no navigation, so
the deep-link scroll/focus effect (keyed on the parsed handle) does not re-fire. The only
reachable instance is re-clicking the same overview inline-lint finding after scrolling
away: the correct surface is already showing, but the rail does not re-scroll to the
element. Fixing it would add a second owner for scroll position alongside the URL effect,
so it is recorded here rather than patched.

## Verification

- Red/green: two new page-level tests in `SpecsPage.test.tsx` drive the real URL through a
  soft-navigation fake (`next/link` clicks and `router.replace` rewrite the jsdom URL and
  wake `useSearchParams`). Both failed before the fix with "Unable to find …" and pass after.
- A third test covers the traceability "Open <handle>" link at the page level, replacing the
  component-level test that asserted the deleted `onOpenElement` compensation.
- Live: replayed the exact reported sequence against this worktree's dev server on a seeded
  spec (`plc-test-lab/deep-link-repro`). `?el=Q2` and `?el=Q3` now open the Questions surface
  with the target element focused; `?view=history` reloads onto History.
