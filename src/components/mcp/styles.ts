// Shared appearance recipes for the MCP configuration UI, migrated from the
// legacy `.mcp-*` rules in globals.css. Recipes consumed by more than one MCP
// component live here to avoid duplication; single-use appearance stays inline
// in its component. State is expressed via data-* utilities by the caller.
//
// `--accent-cyan` / `--accent-amber` are referenced through arbitrary utilities
// because they have no @theme alias; they resolve identically to the legacy
// var() usage, preserving parity. The pending-dot animation is held at its
// legacy 1.2s cadence via an arbitrary `animate-[…]` rather than the canonical
// `--animate-pulse-dot` token (2.5s), which would change the pulse speed.

// `.mcp-config-trigger` base — the pill-shaped prompt-toolbar / capability
// trigger button (static box + disabled state). Callers add hover (gated to the
// closed state for the config button) and open / overrides state on top.
export const triggerBase =
  "relative inline-flex items-center gap-[0.4rem] appearance-none rounded-[4px] " +
  "border border-solid border-border-subtle bg-bg-surface text-text-secondary " +
  "font-mono text-[0.72rem] px-[0.65rem] py-[0.35rem] cursor-pointer " +
  "transition-[background,color,border-color] duration-[120ms] " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

// `.mcp-config-trigger:hover:not(:disabled)` — the hover recolour, ungated.
export const triggerHover =
  "enabled:hover:bg-bg-hover enabled:hover:text-text-primary enabled:hover:border-border-default";
