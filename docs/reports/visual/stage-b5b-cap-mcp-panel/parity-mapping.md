# Stage B-5b — MCP capability panel: parity mapping

Slice: `McpCapabilityPanelContainer.tsx`. ZERO visual change intended. This is
the line-by-line CSS→utility transcription evidence. Pixel before/after capture
is deferred to the B-5b integration human-gate (the running Storybook resolves to
the prefix-sibling worktree, so it cannot render this worktree's edits; the
charter places the human parity gate at integration). The configurator stories
default `activeTab` to `"mcp"`, so the existing
`AgentCapabilitiesConfigurator.stories.tsx` (Inline + Drawer) already render the
migrated MCP toolbar/scope-note chrome (panel body shows its loading state, as
in prod without MSW).

## Ownership

- Migrated to utilities + conditional class maps: `McpCapabilityPanelContainer.tsx`.
- Deleted from globals.css (mcp-specific only, grep-verified single-consumer):
  `.agent-capability-panel__rows--mcp`, `.agent-capability-row--mcp` (standalone),
  and the whole `.agent-capability-mcp-tools*` / `.agent-capability-mcp-tool*`
  block (head, tool, :first-child, __dot, __name, __state, __empty, + both
  `[data-effective="off"]` descendant rules).
- LEFT INTACT (shared — `AgentCapabilityPanel.tsx` still consumes them; the
  capability-panel-core slice deletes them): every `.agent-capability-panel*`,
  `.agent-capability-row*` (non-mcp), `.agent-capability-filter*`,
  `.agent-capability-inheritance*` rule, including the three `:not(.…--mcp)`
  negations (2965, 3028) and the `@media768` `.agent-capability-row, …--mcp`
  group rule (now harmlessly referencing an unused modifier — core slice cleans).
- Untouched: leaf recipes (`btn btn-ghost btn-sm` kept on every button),
  preserved floor, eslint/.prettierrc, the baseline, session.css, conversation.css.
  No allowlist edit needed — the `…/components/agent-capabilities/…` dir entry in
  `UTILITY_FIRST_PATHS` (collision test) added by the drawer-shell slice covers
  this file.

## CRITICAL cascade finding — the shared panel/row classes are 3-way merges

Each shared `.agent-capability-*` class is defined by **up to three** equal-
specificity blocks that the cascade MERGES (later source wins per-property):
the prototype block (~2057–2415), the middle "prototype refresh" block
(~2426–2698), and the current block (~2825–3277), plus `@media` overrides. The
effective rendered style is the per-property merge — NOT any single block. The
utilities below reproduce the **merged effective** style. Notable merge
resolutions (for the capability-panel-core slice, which owns these same classes):

- **Search input `border-radius` = `md`, not `sm`.** The old block (2147) set
  `sm`; the middle block (2546) set `md` and wins. → `rounded-md`.
- **`.agent-capability-row--enabled` is DEAD.** It only sets `border-color`
  (green-dim @2226, then re-set to subtle @2604), but the later base
  `.agent-capability-row { border: 1px solid subtle }` (@2954) re-sets the whole
  border AFTER both → the enabled row shows the plain subtle border. Reproduced
  by omitting any enabled-border utility (parity = current rendering). Dead-rule,
  like the `cap-tab__group:first-child` finding in the drawer-shell notes.
- **`.agent-capability-inheritance` weight = 500.** Middle block @2676 set 600;
  current group @3150 sets 500 and wins → `font-medium`. Explicit/explicit-off
  border colors resolve to the current group's literals
  `rgba(0,229,255,0.25)` / `rgba(255,179,0,0.25)` (NOT cyan-dim/amber-dim).
- **Toolbar border** = `border-border-dim` on T/R/L (@2123 `border:1px dim`) with
  `border-b-border-subtle` overriding the bottom (@2837 `border-bottom`), plus
  `rounded-md` (@2123) and `bg-bg-void` (@2837). → `border border-solid
  border-border-dim border-b-border-subtle rounded-md`.

## data-effective → boolean (no ancestor-hook variants)

The deleted descendant rules `…row[data-effective="off"] …__name`,
`…mcp-tool[data-effective="off"] …__dot/__name` were data-attribute driven. The
migration computes the state in JSX (`server.enabled`, `effectiveOn =
serverEnabled && tool.enabled`) and applies the off-state utilities conditionally
via `cn()` — cleaner than `[[data-effective=off]_&]:` and avoids relying on
`cn` (clsx-only, no merge). `data-effective`/`data-server-id` attributes are kept
(harmless; no remaining CSS consumer after the mcp* deletions).

## drawer-mode parity — `[[data-cap-drawer]_&]:`

The toolbar (`px-xl py-md` → drawer `px-lg py-sm`) and rows
(`px-xl pt-md pb-xl` → drawer `px-lg pt-sm pb-lg`) padding overrides are the
shared `[data-cap-drawer] .agent-capability-panel__{toolbar,rows}` rules (2847,
2940). Since `data-cap-drawer` sits on the configurator root (ancestor of this
container), they are reproduced as ancestor-hook utility variants
`[[data-cap-drawer]_&]:…` — same mechanism as drawer-shell decision #1, applied
as utilities here because this file keeps the shared rules rather than folding
them.

## Element-by-element (merged effective → utilities)

| Element | Merged effective | Utilities |
|---|---|---|
| root `<section>` (`panel`+`--mcp` no-op) | flex;flex 1 1 auto;col;min-h0;min-w0;bg-base | `flex min-h-0 min-w-0 flex-auto flex-col bg-bg-base` |
| toolbar | flex;min-w0;flex 0 0 auto;wrap;items-center;gap-sm;pad md xl;border dim+bottom subtle;radius md;bg void (drawer pad sm lg) | `flex min-w-0 flex-none flex-wrap items-center gap-sm rounded-md border border-solid border-border-dim border-b-border-subtle bg-bg-void px-xl py-md [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:py-sm max-900:flex-col max-900:items-stretch` (toolbar column collapse is `@media (max-width: 900px)`, not 768) |
| field `<label>` | flex;col;items-center;flex 1;min-w180;max-w360;gap7;pad6/10;border subtle;radius md;bg base;mono .7rem 600 upper ls.06;secondary;focus cyan+glow (m768 max-w none) | `flex min-w-[180px] max-w-[360px] flex-1 flex-col items-center gap-[7px] rounded-md border border-solid border-border-subtle bg-bg-base px-[10px] py-[6px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-secondary transition-all duration-150 focus-within:border-cyan focus-within:shadow-[0_0_0_3px_var(--cyan-glow)] max-900:max-w-none` (field `max-width:none` is the same `@media (max-width: 900px)` rule, not 768) |
| sr-only `<span>` | abs;1×1;hidden;clip;nowrap | `absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]` |
| input | w100;min-h34;pad6/8;border0;outline0;radius md;bg transparent;mono .76rem;primary;none case;ls0;ph tertiary | `min-h-[34px] w-full rounded-md border-0 bg-transparent px-[8px] py-[6px] font-mono text-[0.76rem] normal-case tracking-normal text-text-primary outline-0 placeholder:text-text-tertiary` |
| filters | flex;wrap;items-center;gap2;pad2;border subtle;radius md;bg base | `flex flex-wrap items-center gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-base p-[2px]` |
| filter `<button>` | inline-flex;items-center;gap6;min-h24;pad4/9;border0;radius sm;bg transparent;mono .7rem 500;hover primary;active raised+cyan (m768 min-h touch) | base `inline-flex min-h-[24px] cursor-pointer items-center gap-[6px] rounded-sm border-0 bg-transparent px-[9px] py-[4px] font-mono text-[0.7rem] font-medium transition-all duration-150 hover:text-text-primary max-768:min-h-[var(--touch-target-min)]`; active `bg-bg-raised text-cyan` / else `text-text-secondary` |
| scope-note | ml-auto;mono .7rem;tertiary;nowrap | `ml-auto whitespace-nowrap font-mono text-[0.7rem] text-text-tertiary` |
| notice | pad sm;radius sm;mono .78rem;secondary;bg base | `rounded-sm bg-bg-base p-sm font-mono text-[0.78rem] text-text-secondary` |
| error | pad sm;radius sm;mono .78rem;red;bg red-glow;border red-dim | `rounded-sm border border-solid border-red-dim bg-red-glow p-sm font-mono text-[0.78rem] text-red` |
| rows (`--mcp`) | grid;flex 1 1 auto;min-h0;content-start;auto-rows auto;gap xs;overflow-y;pad md xl xl (drawer sm lg lg) | `grid min-h-0 flex-auto auto-rows-auto content-start gap-xs overflow-y-auto px-xl pb-xl pt-md [[data-cap-drawer]_&]:px-lg [[data-cap-drawer]_&]:pb-lg [[data-cap-drawer]_&]:pt-sm` |
| empty | pad sm;radius sm;mono .78rem;tertiary;dashed default | `rounded-sm border border-dashed border-border-default p-sm font-mono text-[0.78rem] text-text-tertiary` |
| row `<article>` (`--mcp`) | grid;cols 28px/1fr/auto;items-center;gap md;min-w0;mb sm;pad11/14;border subtle;radius md;bg surface;trans;hover default;explicit→left 2px cyan/amber (m900 cols 1fr) | `grid min-w-0 grid-cols-[28px_minmax(0,1fr)_auto] mb-sm items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-surface px-[14px] py-[11px] transition-[border-color,background] duration-150 hover:border-border-default max-900:grid-cols-[1fr]` (`.agent-capability-row(--mcp)` single-column is `@media (max-width: 900px)`, not 768) + explicit `border-l-2 border-l-cyan` / off `border-l-2 border-l-amber` |
| expand `<button>` | flex;center;22×22;border0;bg transparent;mono 1rem;tertiary;trans transform/color (expanded rotate90+cyan) | `flex h-[22px] w-[22px] items-center justify-center border-0 bg-transparent font-mono text-base [transition:transform_0.2s_ease,color_0.15s_ease]` + expanded `rotate-90 text-cyan` / else `text-text-tertiary` |
| body | grid;min-w0;gap xs | `grid min-w-0 gap-xs` |
| main | flex;items-start;justify-between;gap md;min-w0 (m768 col) | `flex min-w-0 items-start justify-between gap-md max-768:flex-col` |
| identity | grid;gap3;min-w0 | `grid min-w-0 gap-[3px]` |
| name | min-w0;wrap-anywhere;hidden;ellipsis;nowrap;mono .86rem 500;on primary / off secondary+strike(tertiary,1px) | `min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.86rem] font-medium [overflow-wrap:anywhere]` + on `text-text-primary` / off `text-text-secondary line-through decoration-text-tertiary decoration-1` |
| id | min-w0;wrap-anywhere;hidden;ellipsis;nowrap;mono .7rem;tertiary | `min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.7rem] text-text-tertiary [overflow-wrap:anywhere]` |
| details | flex;items-center;wrap;min-w0;gap sm;mt5;mono .7rem;tertiary | `mt-[5px] flex min-w-0 flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-tertiary` |
| details > span | min-w0;wrap-anywhere (`DETAILS_SPAN`) | `min-w-0 [overflow-wrap:anywhere]` on every direct span (incl. chip) |
| control-note | +mono .7rem tertiary | `cn(DETAILS_SPAN,"font-mono text-[0.7rem]")` (tertiary inherited) |
| controls | flex;items-center;wrap;justify-end;gap sm | `flex flex-wrap items-center justify-end gap-sm` |
| reset `<button>` | btn leaf + (m768 min-h touch) | `btn btn-ghost btn-sm max-768:min-h-[var(--touch-target-min)]` |
| switch `<button>` | rel;flex 0 0 auto;34×18;border default;radius full;bg base;cursor;trans;on→cyan+glow | `cn(SWITCH_BASE,"h-[18px] w-[34px]", on?SWITCH_ON:SWITCH_OFF)` |
| switch knob `<span>` | abs;1/1;14×14;radius full;bg tertiary;trans;on→translateX16+inverse | `cn(SWITCH_KNOB,"h-[14px] w-[14px]", on?"translate-x-[16px] bg-text-inverse":"bg-text-tertiary")` |
| inheritance chip | inline-flex;items-center;gap4;pad2/7;border subtle;radius full;mono .7rem 500;tertiary;nowrap +DETAILS_SPAN; explicit cyan/glow/rgba; off amber/glow/rgba | `CHIP_BASE` + `CHIP_EXPLICIT` / `CHIP_EXPLICIT_OFF` / `border-border-subtle` |
| mcp-tools | col 1/-1;m sm -md -sm;pad sm lg md;border-top subtle;bg base | `col-[1/-1] -mx-md -mb-sm mt-sm border-t border-x-0 border-b-0 border-solid border-border-subtle bg-bg-base px-lg pb-md pt-sm` (`border-x-0 border-b-0` zeroes the non-top sides — Preflight off, default border-width is `medium`) |
| tools head | grid;cols 1fr auto;items-center;gap md;pad6/0;mono .7rem 600 upper ls.08;tertiary | `grid grid-cols-[1fr_auto] items-center gap-md py-[6px] font-mono text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary` |
| tools empty/loading/idle/error | mono .7rem;tertiary | `font-mono text-[0.7rem] text-text-tertiary` |
| tools list | (no rule) | bare `<div>` |
| tool row | grid;cols 12px/1fr/auto/auto/auto;items-center;gap md;pad6/0;mono;border-top dim;first none | `grid grid-cols-[12px_minmax(0,1fr)_auto_auto_auto] items-center gap-md border-t border-x-0 border-b-0 border-solid border-border-dim py-[6px] font-mono first:border-t-0` (`border-x-0 border-b-0` zeroes the non-top sides — Preflight off, default border-width is `medium`) |
| tool dot | 5×5;ml3;radius full;on green+glow / off tertiary+none | `cn("ml-[3px] h-[5px] w-[5px] rounded-full", on?"bg-green shadow-[0_0_6px_var(--green-glow)]":"bg-text-tertiary shadow-none")` |
| tool name | hidden;ellipsis;nowrap;.76rem;on primary / off secondary+strike(1px, currentColor) | `cn("overflow-hidden text-ellipsis whitespace-nowrap text-[0.76rem]", on?"text-text-primary":"text-text-secondary line-through decoration-1")` |
| tool state | mono .7rem;tertiary | `font-mono text-[0.7rem] text-text-tertiary` |
| tool reset | btn leaf (`__reset` unstyled) | `btn btn-ghost btn-sm` |
| tool switch `<button>` | switch + small 26×14 + disabled cursor/opacity | `cn(SWITCH_BASE,"h-[14px] w-[26px] disabled:cursor-not-allowed disabled:opacity-45", on?SWITCH_ON:SWITCH_OFF)` |
| tool switch knob | small 10×10;on→translateX12+inverse | `cn(SWITCH_KNOB,"h-[10px] w-[10px]", on?"translate-x-[12px] bg-text-inverse":"bg-text-tertiary")` |

## Gates

- Green: `typecheck`, `lint` (0 errors), targeted vitest (31 passed: collisions +
  AgentCapabilityPanel + stories + both stranded config tests + PromptComposer),
  `css:progress --check` (globals.css decreased; ratchet OK).
- Deferred to B-5b integration (per charter): pixel parity human-gate;
  eslint `MIGRATED_UTILITY_FIRST` + `.prettierrc` registration; baseline regen.
- No brittle class assertions referenced mcp/panel classes (PromptComposer
  already targets `button[aria-label="Agent capability configuration"]` from the
  drawer-shell slice) — none to delete.
