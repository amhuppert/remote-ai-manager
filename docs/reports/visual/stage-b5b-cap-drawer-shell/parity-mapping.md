# Stage B-5b — agent-capability drawer shell: parity mapping

Slice: drawer-shell + stranded B-2 config files. ZERO visual change intended.
This report is the line-by-line CSS→utility transcription evidence for the
migrated chrome. Pixel before/after capture is deferred to the integration
human-gate (the running Storybook resolves to the prefix-sibling worktree, so it
cannot render this worktree's edits; the charter places the human parity gate at
integration). A reviewable after-state lives in
`AgentCapabilitiesConfigurator.stories.tsx` (Inline = config mount, Drawer =
drawer chrome).

## Token utility conventions used (from theme.css)

- `--space-*` → `--spacing-*` → `p-*/m-*/gap-*` (e.g. `var(--space-xl)` → `px-xl`).
- backgrounds `bg-bg-{void,base,raised,hover}`, borders `border-border-{subtle,default,strong}`,
  text `text-text-{primary,secondary,tertiary}`, accents `text-cyan`/`text-violet`/`border-b-cyan`.
- radii `rounded-{sm}`, fonts `font-{display,mono}`, z `z-dropdown` (200/201 collapse to the dropdown tier; drawer stays above the scrim by DOM order).
- Single-side borders zero the other three sides (Preflight OFF, §1.5):
  `border-x-0 border-b-0 border-t …`.

## Element-by-element (merged effective styles — both `agent-capabilities-*` BEM and `cap-*` classes co-occur on each element; later `cap-*` rule wins overlaps)

| Element | Legacy effective | Utilities |
|---|---|---|
| root `<section>` | `display:flex;flex-direction:column;gap:md;min-width:0;min-height:0;height:100%;bg-base;text-primary` | `flex h-full min-h-0 min-w-0 flex-col gap-md bg-bg-base text-text-primary` + `data-cap-drawer` hook |
| header | `flex;flex-col;items:stretch;justify:flex-start;flex:0 0 auto;border-bottom 1px subtle;padding xl xl 0` (drawer: padding lg lg 0) | `flex flex-none flex-col items-stretch justify-start border-x-0 border-t-0 border-b border-solid border-border-subtle` + `px-xl pt-xl` / drawer `px-lg pt-lg` |
| title-row | `flex;items:flex-start;justify:space-between;gap:md;margin-bottom:md` | `mb-md flex items-start justify-between gap-md` |
| title `<h1>` | `font-display;1.7rem;800;lh1.1;ls0;text-primary` (drawer: 1.2rem;700) | `font-display leading-[1.1] tracking-normal text-text-primary` + `text-[1.7rem] font-extrabold` / drawer `text-[1.2rem] font-bold` |
| accent `<span>` | `color:cyan;text-shadow:0 0 18px var(--cyan-glow-text)` | `text-cyan [text-shadow:0_0_18px_var(--cyan-glow-text)]` |
| subtitle `<p>` | `margin-top:xs;font-mono;0.76rem;text-secondary` | `mt-xs font-mono text-[0.76rem] text-text-secondary` |
| close `<button>` | `inline-flex;center;30×30;border 1px default;radius-sm;transparent;text-secondary;font-mono;1rem;hover bg-hover/text-primary/border-strong` | `inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent font-mono text-base text-text-secondary transition-all duration-150 hover:border-border-strong hover:bg-bg-hover hover:text-text-primary` |
| tabs container | `flex;wrap;items:stretch;margin 0 -xl;padding 0 xl;border-top 1px subtle;transparent` (drawer: column;margin 0 -lg;padding 0 lg) | `flex flex-wrap items-stretch border-x-0 border-b-0 border-t border-solid border-border-subtle bg-transparent` + `-mx-xl px-xl` / drawer `-mx-lg flex-col px-lg` |
| tab group | `flex;items:stretch;shrink:0;min-width:0` (drawer: self-stretch; border-top 1px subtle except first) | `flex min-w-0 shrink-0 items-stretch` + drawer `self-stretch` + drawer&i>0 top-border |
| group label `<span>` | `flex;center;gap5;self-stretch;font-mono 0.7rem 600 ls.1em upper text-tertiary; [data-agent=claude]→cyan,codex→violet`. EFFECTIVE ml/pl/border-left = ALWAYS 0: the label `<span>` is the first child of every `.cap-tabs__group`, so `.cap-tab__group:first-child` matches every label and zeroes `ml/pl/border-left` for all groups (the base rule's `ml md;pl md;border-left 1px` is dead — never observed). `pr sm` survives. (drawer: min-w84;ml0;pl0;pr md;no-left) | base `flex items-center gap-[5px] self-stretch font-mono text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-text-tertiary data-[agent=claude]:text-cyan data-[agent=codex]:text-violet`; non-drawer `ml-0 pl-0 pr-sm` (no border-left, no per-group separator — matches legacy `:first-child` cascade); drawer `ml-0 min-w-[84px] pl-0 pr-md` |
| tab `<button>` | `flex;center;gap7;pad 11/14;border-bottom 2px transparent;transparent;text-secondary;font-mono 0.74rem 500;nowrap;transition color/border .15s; hover→text-primary; active→text-primary + bottom cyan (codex violet)` | base `flex items-center gap-[7px] … border-x-0 border-t-0 border-b-2 border-solid border-transparent … px-[14px] py-[11px] font-mono text-[0.74rem] font-medium transition-[color,border-color] duration-150`; inactive `text-text-secondary hover:text-text-primary`; active `border-b-cyan text-text-primary data-[agent=codex]:border-b-violet` |
| tab count `<span>` | `pad 1/5;radius 9999px;bg-raised;text-tertiary;0.7rem` | `rounded-full bg-bg-raised px-[5px] py-[1px] text-[0.7rem] text-text-tertiary` |
| footer | `flex:0 0 auto;flex;center;gap md;pad 10/xl;border-top 1px subtle;bg-void;text-secondary;font-mono 0.7rem` (drawer: pad 8/lg) | `flex flex-none items-center gap-md border-x-0 border-b-0 border-t border-solid border-border-subtle bg-bg-void font-mono text-[0.7rem] text-text-secondary` + `px-xl py-[10px]` / drawer `px-lg py-[8px]` |
| foot `.diag` / `strong` / `.spacer` | `flex;center;gap5` / `text-primary` / `flex:1` | `flex items-center gap-[5px]` / `text-text-primary` / `flex-1` |
| drawer overlay (stranded) | `fixed;inset0;z200;bg rgba(6,9,15,.6);backdrop blur4 saturate120%` | `fixed inset-0 z-dropdown bg-[var(--cc-bg-void-a60)] [backdrop-filter:blur(4px)_saturate(120%)]` |
| drawer aside (stranded) | `fixed;t/r/b 0;z201;flex col;w min(720px,100vw);border-left 1px default;bg-base;shadow -16px 0 48px rgba(0,0,0,.55)` | `fixed bottom-0 right-0 top-0 z-dropdown flex w-[min(720px,100vw)] flex-col border-y-0 border-r-0 border-l border-solid border-border-default bg-bg-base shadow-[-16px_0_48px_var(--cc-black-a55)]` |
| trigger (stranded) | `cn(triggerBase,triggerHover,"agent-capability-trigger")` where `.agent-capability-trigger{min-width:118px}` | `cn(triggerBase,triggerHover,"min-w-[118px]")` |

## Cross-slice / boundary decisions (cited governing source)

1. **`data-cap-drawer` hook instead of `.cap-root--drawer` class** (conventions §1.2/§1.3).
   Two drawer-context PANEL rules style an out-of-scope child:
   `.cap-root--drawer .agent-capability-panel__{toolbar,rows}`. Migrating the root
   removes the `.cap-root--drawer` class, which would drop those overrides
   (parity break) — yet the panel is a later slice (cannot be touched). Resolved
   by repointing only the parent-hook of those two rules to `[data-cap-drawer]`
   (declarations untouched, panel styling identical) and setting `data-cap-drawer`
   on the migrated root in drawer mode. The migrated root therefore carries ZERO
   legacy classes; the panel slice folds these two rules into its own migration.

2. **Mint `--cc-black-a55: rgba(0,0,0,0.55)` — FORCED by an active guardrail, not
   discretionary** (conventions §7 + the active `no-hardcoded-color` rule).
   Attempt-1 review flagged this as out-of-ownership and asked for a non-tokens.css
   rework; that rework is provably IMPOSSIBLE. The two stranded files are ALREADY in
   eslint `MIGRATED_UTILITY_FIRST` (since B-2 — see `eslint.config.mjs` lines 40-41),
   so `no-hardcoded-color` is active on them and an inline `rgba(0,0,0,0.55)` literal
   in the shadow utility FAILS lint (verified). No value-identical token exists
   (a45/a50/a35/a20/a40; using a50/a45 would shift the shadow = visual change), so
   reuse is out. Completing the task (removing these files' legacy classes) requires
   the shadow in `className`, which the guardrail requires be a `var(--cc-*)` token.
   The "defer token minting to integration" pattern applies only to slices whose
   files are NOT yet eslint-allowlisted (e.g. the composer wave shipped an inline
   shadow literal precisely because its file wasn't guarded yet); it cannot apply
   here. Minting is therefore intrinsic to the assigned task. Added next to the other
   `--cc-black-a*`; shadow references it via `var()`. Overlay scrim `rgba(6,9,15,0.6)`
   reused the existing `--cc-bg-void-a60` (reuse, not mint). Source resolution: the
   B-5b no-new-token guidance assumes a token-free alternative exists; where an
   active guardrail (conventions §4/§7, source #4) leaves none, §7 token extraction
   governs — same mechanism B-4/B-5a used to add `--cc-*` tokens.

3. **Remove `agent-capability-trigger` class + retarget PromptComposer.test.tsx**
   (conventions §4.7). The only rule was `min-width:118px` → `min-w-[118px]`.
   `PromptComposer.test.tsx` located the trigger via the now-deleted
   `.agent-capability-trigger` class selector; retargeted to the existing
   `button[aria-label="Agent capability configuration"]` (a11y attribute, no
   class). This keeps the tree green and satisfies "no migrated element carries a
   legacy class"; the test edit is pure brittle-className-selector cleanup (§4.7),
   no production behavior change.

## Allowlist + gates

- `UTILITY_FIRST_PATHS` (collision test): the two file-scoped entries replaced by
  one dir entry `…/components/agent-capabilities/…` (covers this + the later panel
  slices; their not-yet-migrated classes stay rule-backed so no collision exists).
- Deferred to integration (per charter): eslint `MIGRATED_UTILITY_FIRST` +
  `.prettierrc` registration; baseline regeneration; pixel parity human-gate.
- Green: `typecheck`, `lint` (0 errors), targeted vitest (25 passed:
  collisions + both stranded config tests + panel + PromptComposer),
  `css:progress --check` (globals.css decreased).
