// Shared utility recipes for the diff file/line rendering used by both
// DiffPanel (uncommitted diff) and CommitHistory (inline commit diff). Kept in
// one place so the two consumers stay byte-identical; the legacy `.diff-*`
// rules they replace lived in session.css and applied to both.

// Single-side bottom border (Preflight is OFF): zero the other three sides
// explicitly so `border-solid` doesn't render a ~3px box.
export const DIFF_FILE_SECTION_CLASS =
  "min-w-fit border-x-0 border-t-0 border-b border-solid border-border-subtle last:border-b-0";

// Base header box (sticky, hover, cursor). DiffPanel composes `group/dfh` +
// `data-collapsed` for the chevron rotate; CommitHistory uses it as-is.
export const DIFF_FILE_HEADER_CLASS =
  "sticky top-0 z-raised flex cursor-pointer select-none items-center gap-[6px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-raised px-md py-sm text-[0.72rem] font-semibold text-text-secondary transition-[background] duration-100 ease-[ease] hover:bg-bg-hover max-768:px-sm max-768:py-xs max-768:text-[0.7rem]";

export const DIFF_FILE_NAME_CLASS =
  "flex-1 overflow-hidden text-ellipsis whitespace-nowrap max-768:min-w-0";

export const DIFF_FILE_STAT_CLASS = "shrink-0 text-[0.7rem] font-normal";

// diff-line: base box (no color/bg) + a per-type map so add/remove/context/
// hunk-header each set border-left-color, color, and bg exactly once (no
// same-property utility collision against a shared default).
export const DIFF_LINE_BASE =
  "whitespace-pre border-y-0 border-r-0 border-l-[3px] border-solid px-md max-768:px-sm";

export const DIFF_LINE_TYPE: Record<string, string> = {
  add: "border-l-green bg-[var(--cc-green-a06)] text-green",
  remove: "border-l-red bg-[var(--cc-red-a06)] text-red",
  context: "border-l-transparent text-text-tertiary",
  "hunk-header": "border-l-transparent bg-cyan-glow font-medium text-cyan-dim",
};
