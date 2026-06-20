# Stage B-2 retry — before/after parity captures (Storybook)

Real before/after screenshots for the components migrated in the integration
retry (desktop 1440×900, mobile 390×844), via Playwright over a served
`storybook-static`, with CSS animations/transitions frozen
(`animation:none;transition:none`, reduced-motion) for deterministic capture.

Method: build storybook at HEAD → capture `*__after.png`; revert `src/` to the
pre-migration commit `55e69144` → rebuild → capture `*__before.png` → restore.
Pairs compared with `cmp`.

**Result: 16 pairs — 10 byte-IDENTICAL, 6 DIFFERS (all sub-pixel/animation, visually
identical, no regression):**
- confirmdialog default + danger DESKTOP: byte-IDENTICAL. MOBILE: sub-pixel AA on
  the `<Button>` primitive vs legacy `.btn` (visually identical — see the committed
  pair; modal/title/message/buttons match).
- modelselector default desktop+mobile: byte-IDENTICAL.
- topbar projects (desktop) + mobile-projects: byte-IDENTICAL.
- approvalgatepanel default + submitting desktop+mobile: byte-IDENTICAL.
- reasoninglevelselector default + claude-opus-x-high (rainbow) desktop+mobile:
  DIFFERS — the plain trigger differs only by sub-pixel text AA; the rainbow
  trigger differs by frozen gradient phase. Both render visually identical to
  legacy (verified).

ProjectsIndexPage and SessionDiffViewer (hook-driven pages, no isolated story) are
under `../_b2-retry-app/`.
