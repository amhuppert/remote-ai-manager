# UI primitive layer — notes for downstream contexts

Committed by the primitives context (tasks 4.1–4.3). What the pilot and Stage B
feature-wave contexts need to know about `cn()` + the canonical primitives.

## Key files

- **`src/lib/ui/cn.ts`** — `cn(...inputs: ClassValue[])`, a thin `clsx` wrapper.
  `tailwind-merge` is deliberately NOT layered on (decision 5 / YAGNI): primitives
  compose appearance once and append `layoutClassName` (external geometry only)
  last, so there is no conflicting-override case to merge.
- **`src/components/ui/{Button,Badge,StatusDot,Tabs,SectionHeader,ModalShell}.tsx`**
  — the six primitives + their `*.stories.tsx` parity harness.
- **`src/components/ui/primitives.test.tsx`** — 44 unit assertions (with cn) over
  every variant × data-* state; the executable spec of each primitive's parity
  class set.

## How the primitives are authored (the pattern to reuse)

- **Utilities, not legacy classes, not `@apply`.** Class maps emit Tailwind
  utilities: token utilities where a `@theme` token exists (`bg-cyan`, `gap-sm`,
  `rounded-md`, `text-text-secondary`, `z-dropdown`, `animate-pulse-dot`), and
  arbitrary `[...]` utilities for legacy literals with no token (`px-[18px]`,
  `text-[0.78rem]`, `border-[rgba(255,61,90,0.3)]`, multi-layer `shadow-[...]`).
  `@apply`/component-layer classes stay reserved for vendor/generated DOM that
  cannot receive props (none of these six).
- **Appearance is partitioned OUT of `base`.** Any property that varies by
  variant/size/state lives in its map entry, never in `base`, so no two applied
  utilities ever target the same CSS property. This is why Button's `base` has no
  background/color/font-weight/padding and `sm` fully replaces `md` padding — do
  the same when adding primitives, otherwise you depend on Tailwind's
  same-property sort order (which we must not, without tailwind-merge).
- **State = `data-*` + `data-[…]:` variants.** Active/collapsed/etc. are emitted
  as `data-*` attributes and the appearance is `data-[active=true]:…`. Where one
  state must beat another (Tab active beats hover, matching legacy source order)
  the two are gated on **mutually exclusive** attribute values
  (`data-[active=true]:…` vs `data-[active=false]:hover:…`) so the result is
  independent of variant emission order.
- **`className`/`style` are omitted at the type level.** The only escape hatch is
  `layoutClassName` — external geometry only (margin, grid/flex placement, order,
  self/justify-self, width/basis), appended LAST. Appearance utilities there are
  a lint failure post-pilot. See `docs/tailwind-conventions.md` §2 for the
  allowlist.

## Parity scope / decisions that bind later waves

- **Button has a `default` (neutral) variant** beyond design.md's
  primary/danger/success/ghost — the bare `.btn` neutral is a real legacy class
  (`btn btn-sm`). Source-of-truth: requirement 4.2 "parity-equivalent to the
  legacy class" outranks the design enum.
- **`.btn-icon-only` and `.btn-toggle` are NOT covered.** They are not among the
  six design primitives; their square/touch-target and toggle semantics are Stage
  B work (a future primitive or utilities).
- **StatusDot pulses unconditionally** for every tone — legacy `.status-dot` has
  the animation on the base rule (modifiers only change color) and globals.css
  has no `prefers-reduced-motion` override for it, so the primitive adds none
  (parity). `warning` and `amber` are intentionally identical.
- **ModalShell is presentational** (parity with legacy `.modal`/`.modal-overlay`,
  which carry no role). It sets NO `role`/`aria-modal`; the consumer supplies a11y
  semantics via rest props (the stories pass `role="dialog"` +
  `aria-labelledby`). Overlay z-index uses the `dropdown` tier (200);
  `fadeIn` is held at the legacy 0.15s via `animate-[fadeIn_0.15s_ease]` rather
  than the canonical 0.3s `--animate-fade-in` token (parity over canonicalisation).
- **`hover:` wraps in `@media (hover: hover)`** (Tailwind default). Desktop parity
  is exact; on touch the legacy tap-hover does not fire — accepted as the
  idiomatic, arguably-better behavior. Confirm in the pilot's mobile screenshots.

## Verification done

- `cn` + primitives unit suite: 44/44 (`bunx vitest run --project unit
  src/lib/ui src/components/ui`).
- Every primitive utility compiled through `@tailwindcss/postcss` (Preflight-off
  toolchain) and confirmed to emit its exact declaration — including the at-risk
  composite-var cases (bare `border` → solid 1px via the emitted
  `@property --tw-border-style`, multi-layer `shadow-[...]`, `backdrop-blur-[8px]`,
  the `transition-all`+`duration-150`+`ease-[ease]` trio, `data-[…]` selectors).
- `bun run typecheck`, `bun run lint` (0 errors), `bun run build`, and
  `bun run build-storybook` all green.
- Stories set `a11y: { test: "error" }` so the Storybook test project fails on any
  axe violation in the primitive harness.

## NEGATIVE constraints (still true after this context)

No existing call site was switched to a primitive; no legacy CSS was deleted.
Call-site migration begins with the pilot (`ProjectCard` + a leaf control).
