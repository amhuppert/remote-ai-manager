# Research & Design Decisions

## Summary

- **Feature**: `ui-design-system`
- **Discovery Scope**: Extension — formalizing an existing design system already implemented in `globals.css` and documented in `memory-bank/design-system.md`
- **Key Findings**:
  - The design system is already fully implemented in CSS; the spec formalizes it rather than building from scratch
  - The single CSS file architecture (`globals.css`) is appropriate for this project's scale — no need to split tokens into separate files
  - Font loading via `next/font/google` with CSS variable pattern is already correctly implemented in `layout.tsx`

## Research Log

### Existing Implementation Coverage

- **Context**: Determine what already exists vs. what needs to be built
- **Sources Consulted**: `src/app/globals.css` (1859 lines), `src/app/layout.tsx`, `src/components/Topbar.tsx`, `src/components/ConfirmDialog.tsx`, `src/app/projects/[name]/[session]/LayoutSwitcher.tsx`, `src/types/index.ts`
- **Findings**:
  - All 23 requirements are already implemented in `globals.css` — tokens, components, responsive breakpoints, animations, atmospheric effects
  - Font loading in `layout.tsx` uses `next/font/google` with CSS variable pattern (`--font-anybody`, `--font-manrope`, `--font-geist-mono`)
  - TypeScript types exist for `LayoutMode` as a union type in `src/types/index.ts`
  - Data attributes (`data-page`, `data-layout`, `data-mobile-panel`) are used in page components for CSS-driven state switching
  - Components use plain CSS classes (no CSS modules, no Tailwind, no styled-components)
- **Implications**: The design document should describe the existing architecture accurately, not propose changes. Implementation tasks will focus on documentation and validation rather than code creation.

### CSS Architecture Pattern

- **Context**: Evaluate whether the single-file CSS approach is appropriate
- **Sources Consulted**: Project steering docs, globals.css structure
- **Findings**:
  - `globals.css` is organized into clearly sectioned blocks (Design Tokens, Reset, Atmospheric Effects, Scrollbar, Animations, Utilities, Components, Responsive)
  - The project is deliberately minimal (no external state management, ORM, or UI frameworks per steering)
  - The single-file approach with CSS custom properties provides adequate organization for a project of this size
  - CSS class naming follows kebab-case BEM-style convention as documented in steering
- **Implications**: No architectural change needed. The spec documents and enforces the existing pattern.

### Font Variable Naming Discrepancy

- **Context**: CSS variables reference `--font-anybody`, `--font-manrope`, `--font-geist-mono` from `next/font` but design tokens use `--font-display`, `--font-body`, `--font-mono`
- **Findings**:
  - `layout.tsx` sets `variable: "--font-anybody"`, `variable: "--font-manrope"`, `variable: "--font-geist-mono"` on the `<html>` element
  - `globals.css` maps these via: `--font-display: var(--font-anybody)`, `--font-body: var(--font-manrope)`, `--font-mono: var(--font-geist-mono)`
  - Components reference only the semantic aliases (`--font-display`, `--font-body`, `--font-mono`), never the raw font variables
- **Implications**: Two-tier variable pattern is intentional and correct. The design should document this indirection as part of the token architecture.

## Architecture Pattern Evaluation

| Option                                 | Description                                                        | Strengths                                               | Risks / Limitations                                                   | Notes                                                     |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| Single CSS file with custom properties | Current approach: all tokens and component styles in `globals.css` | Simple, no build tooling, direct mapping to design spec | Could grow unwieldy for very large projects                           | Appropriate for CSM project scale                         |
| CSS Modules per component              | Split styles into per-component `.module.css` files                | Scoped styles, smaller files                            | Breaks the global token reference pattern, requires import management | Over-engineering for this project                         |
| Tailwind CSS                           | Utility-first CSS framework                                        | Rapid development, built-in design system               | Large migration effort, different mental model, adds dependency       | Conflicts with steering principle of minimal dependencies |

## Design Decisions

### Decision: Keep Single-File CSS Architecture

- **Context**: The design system is fully implemented in `globals.css`; the spec formalizes what exists
- **Alternatives Considered**:
  1. Split into multiple CSS files per domain (tokens.css, components.css, responsive.css)
  2. Migrate to CSS Modules or Tailwind
- **Selected Approach**: Keep `globals.css` as the single source of truth with internal section organization
- **Rationale**: Project steering emphasizes minimal dependencies. The current file is well-organized with clear section headers. Splitting would add import management overhead without meaningful benefit at this project's scale.
- **Trade-offs**: Slightly longer single file (+), no import graph to manage (+), no per-component style scoping (-)
- **Follow-up**: If `globals.css` exceeds ~2500 lines in the future, consider extracting token definitions into a separate `tokens.css`

### Decision: Spec Replaces Legacy Design Document

- **Context**: `memory-bank/design-system.md` contains the existing design system documentation, which has drifted from the CSS implementation (missing mobile patterns, contradictory touch target guidance)
- **Selected Approach**: This spec becomes the canonical design system reference; `memory-bank/design-system.md` is deleted after spec completion
- **Rationale**: Single source of truth. The spec includes all information from the legacy doc plus corrections and additions.

## Risks & Mitigations

- **Risk**: Spec may become outdated if CSS changes without spec updates — Mitigate by running `/kiro:validate-impl ui-design-system` after CSS changes
- **Risk**: New developers may add hard-coded values instead of using tokens — Mitigate by documenting token-only policy in requirement 1.7 and reviewing in PRs

## References

- `src/app/globals.css` — canonical CSS implementation (1859 lines)
- `src/app/layout.tsx` — font loading configuration
- `memory-bank/design-system.md` — legacy design system documentation (to be superseded)
- `ui-design/UI_PRODUCT_REQUIREMENTS.md` — UI product requirements (upstream)
- `ui-design/index.html` — canonical design prototype
