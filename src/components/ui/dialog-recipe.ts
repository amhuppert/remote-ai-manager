// Shared appearance recipe for the Radix-backed modal primitives `Dialog`
// (WAI-ARIA "Dialog (Modal)") and `AlertDialog` (WAI-ARIA "Alert Dialog"). Both
// render the same CC overlay shell — a tokenized scrim + a centred card — so the
// recipe lives here and is imported by both wrappers, mirroring how
// `menu-recipe.ts` is shared by `DropdownMenu` and `ContextMenu`.
//
// Layout note: the card is centred by a dedicated flex layer (`overlayCentering`)
// rather than a `-translate-x/y-1/2` transform on the card itself. The legacy
// `slideUp`/`slideUpSheet` entrance keyframes animate `transform`, which would
// fight a centring transform on the same element; centring via the parent keeps
// the keyframes byte-faithful to the legacy `.modal` card.

export type DialogSize = "default" | "confirm" | "wide";

// Scrim overlay (Radix `*.Overlay`). z-dropdown (200) + tokenized scrim + the
// legacy 8px blur; `fadeIn` held at its legacy 0.15s, gated `motion-safe`.
export const overlayScrim =
  "fixed inset-0 z-dropdown bg-[var(--cc-overlay-scrim)] backdrop-blur-[8px] motion-safe:animate-[fadeIn_0.15s_ease]";

// Full-screen flex layer that centres the card above the scrim. `items-end` on
// mobile docks the card to the bottom for the bottom-sheet variant.
export const overlayCentering =
  "fixed inset-0 z-dropdown flex items-center justify-center";
export const overlayCenteringSheet = "max-768:items-end";

// Edge-anchored positioning layer for the `unstyled` variant: a bare full-bleed
// `inset-0` box that does NOT centre its child, so an edge-anchored card
// (a right-edge slide-over, a bottom sheet, a full-screen immersive surface)
// positions itself with its own `fixed`/`absolute` geometry via
// `layoutClassName`. Kept out of the centring recipe because a centring flex
// context would fight a self-positioned card.
export const overlayStretch = "fixed inset-0 z-dropdown";

// Card (Radix `*.Content`). `w-full` + a `max-w` cap reproduces the legacy
// `min(100vw, max-w)` width; `slideUp` held at its legacy 0.2s, gated
// `motion-safe`.
export const cardBase =
  "relative w-full bg-bg-surface border border-solid border-border-default rounded-lg p-xl motion-safe:animate-[slideUp_0.2s_ease]";

export const cardSize: Record<DialogSize, string> = {
  default: "max-w-[480px]",
  confirm: "max-w-[400px]",
  wide: "max-w-[720px]",
};

// Mobile bottom-sheet treatment (the legacy `.modal` mobile recipe + the
// ConfirmDialog/BulkConfirmModal sheet): full-width, square bottom corners,
// safe-area inset padding, and the `slideUpSheet` entrance.
export const cardSheet =
  "max-768:max-h-[100dvh] max-768:max-w-full max-768:overflow-y-auto max-768:overscroll-contain max-768:rounded-b-none max-768:px-md max-768:py-lg max-768:pb-[calc(var(--space-lg)+env(safe-area-inset-bottom,0))] max-768:motion-safe:animate-[slideUpSheet_0.25s_ease]";

// Title (Radix `*.Title`, an `h2`). The legacy modal heading recipe.
export const dialogTitle = "font-display font-bold text-[1.2rem] mb-lg";

// Description (Radix `*.Description`, a `p`). The legacy modal body recipe.
export const dialogDescription =
  "mb-lg font-mono text-[0.82rem] leading-[1.55] text-text-secondary";

// Actions row — the legacy `.modal-actions` recipe (right-aligned button group).
export const dialogActions = "flex justify-end gap-sm";
