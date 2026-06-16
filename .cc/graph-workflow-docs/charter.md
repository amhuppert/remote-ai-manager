# Workflow Charter

## Mission
Execute the first, parallelizable batch of Stage B Tailwind feature-wave migrations. Stage A already shipped the toolchain, the @theme token bridge, the cn()+6-primitive layer, the pilot, the lint guardrails, and the progress ratchet. This workflow (B-1) first extends the shared primitive set with the leaf recipes the batch needs (notably an icon/toggle button primitive — the pilot left layoutClassName and icon buttons unvalidated), then migrates FIVE self-contained feature surfaces in parallel under strict file-ownership isolation, then regenerates the ratchet baseline and gates on a human visual sign-off. ZERO visual change. Each context leaves a green tree (lint/typecheck/targeted tests); the integration context also runs both builds. Visual parity is human-judged (Chromatic deferred): waves capture before/after screenshots at the conventions doc's fixed desktop+mobile dimensions, and the integration context carries the human-approval gate. The dense, cross-consumed surfaces (project-detail shell, the fused session-workflow+workflows-builder, conversation/session/sidebar/prompt _root partials, the workflow graph) and the end-state cleanup (alias removal, Preflight, docs) are OUT OF SCOPE here — they are a later Stage B-2 workflow.

## Ownership map
PRIMITIVE-EXTENSION context owns ONLY new files under src/components/ui/ (+ docs/tailwind-conventions.md updates); it reads globals.css/project-detail.css for parity but edits neither. EACH PARALLEL WAVE owns exactly one feature CSS file + one feature TSX folder and NOTHING else: workflows-catalog -> src/features/workflows-catalog/styles/workflows-catalog.css + src/features/workflows-catalog/**/*.tsx ; config -> src/features/config/styles/config-editor.css + src/features/config/**/*.tsx ; composer -> src/features/project-detail/composer/styles/composer.css + src/features/project-detail/composer/**/*.tsx ; cockpit -> src/features/project-detail/cockpit/styles/cockpit.css + src/features/project-detail/cockpit/**/*.tsx ; spawn-card -> src/features/_root/spawn-card/spawn-card.css + src/features/_root/spawn-card/**/*.tsx . FORBIDDEN for every parallel wave: src/app/globals.css, any src/features/_root/styles/* partial, src/components/** (primitives + shared components are read-only — render, don't edit), docs/reports/* (incl. the ratchet baseline), eslint.config.mjs, eslint-rules/*, scripts/*. cockpit must NOT touch conversation-panes.css (pane* is cross-consumed); spawn-card must NOT touch prompt.css (prompt-* is cross-consumed). The INTEGRATION context owns docs/reports/css-migration-baseline.json (regenerate) and adds remediation tasks only.

## Conventions
- File-ownership is exclusive per wave: a parallel wave writes ONLY its own feature CSS file and its own feature TSX folder. Any write outside that set is forbidden (it breaks parallel safety).
- Never mix legacy class selectors and Tailwind utilities on one element (full-component migration), including the descendant-selector case (a migrated element must not remain the target of a surviving .parent .child legacy rule).
- Primitives omit className/style; the only style escape hatch is the layout-only layoutClassName slot (external geometry only), appended after appearance utilities.
- Breakpoints stay desktop-first via max-* custom variants — never invert to mobile-first.
- Reusable patterns become primitives (added in the primitive-extension context); feature-specific one-offs are inline utilities. Do not invent ad-hoc primitives inside a feature wave.
- Preflight is OFF: single-side borders must explicitly zero the other three sides (e.g. border-x-0 border-t border-b-0).
- hover: utilities are wrapped by Tailwind in @media (hover:hover); accepted as parity-divergent-but-better on touch.
- Use the arbitrary-descendant-variant idiom for legacy .parent:hover .child rules (e.g. [.group[data-activity=idle]:hover_&]); the conventions doc documents the canonical form.
- tailwind-merge stays absent: appearance utilities must stay partitioned so no two hit the same property; if a real override case appears, surface it — do not reach for twMerge.

## Non-goals
- Do NOT migrate any shared component rendered by these features (ModelSelector, ReasoningLevelSelector, BackendToggle, Topbar, ConfirmDialog, MessageRow / ConversationVirtuosoList family, CardContextMenu) — render them unchanged; their migration is a later serial wave.
- Do NOT edit src/app/globals.css, any src/features/_root/styles/* partial (incl. tokens.css, theme.css, conversation.css, sidebar.css, prompt.css, session.css, conversation-panes.css), or src/components/** beyond the new primitive files — these are cross-consumed or shared.
- Do NOT delete shared leaf-recipe definitions (cc-tab*, cc-badge*, btn-*, empty-*, form-*, cc-ibtn, etc.) from globals.css/project-detail.css — other surfaces still consume them; they are retired in the later cleanup.
- Do NOT migrate project-detail shell, session-workflow, workflows-builder, session-diff, session/sidebar PeekPopover, or any conversation/session/_root dense surface here.
- Do NOT add or remove tokens in tokens.css/theme.css; use arbitrary utilities referencing EXISTING tokens/vars for effects.
- Do NOT adopt Preflight, remove the alias bridge, add tailwind-merge, or add class-variance-authority.

## Vocabulary
- exclusive write-set (one wave owns its feature CSS file + feature TSX folder, nothing shared)
- shared leaf primitive (a reusable recipe extracted to src/components/ui)
- globals-coupled (a feature consuming classes defined in globals.css — it swaps to primitives but does not delete the globals rule)
- ratchet baseline (single docs/reports/css-migration-baseline.json — regenerated only at integration)
- preserved residual (vendor/atmospheric rules a feature CSS file keeps forever, per the inventory)

## Test strategy
Per wave: delete the surface's brittle CSS-class/structure and className assertions (do not update them, never re-add CSS-structure assertions); keep behavioral tests. The per-context deterministic gate is the project preMergeCommand (scoped prettier/eslint/vitest + full tsc); it does NOT run builds or the ratchet. Waves run `bun run css:progress --check` (READ-ONLY) as a self-check — they must not regenerate the baseline. The integration context regenerates the baseline (write mode), runs `bun run build` + `bun run build-storybook` + full css:progress, and collects parity screenshots for human review.

## Known ambiguities
- The pilot did NOT exercise layoutClassName or the icon/toggle-button case — the primitive-extension context must prove both. Icon buttons are pervasive in the batch features (page actions, card menus).
- Visual parity is human-judged; there is no pixel-threshold gate. The integration context's human-approval gate is the sign-off.
- Effect values (shadows, accent borders) often have no token — use arbitrary utilities referencing existing var(--…)/tokens, matching the pilot (e.g. shadow-[…var(--cc-*)…]); do not add new tokens here.

## Source-of-truth hierarchy (highest authority first)

### 1. Spec requirements (WHAT)
- id: `requirements`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/requirements.md`
- access policy: worktree-relative

Authoritative acceptance outcomes and constraints. Requirements win over design/tasks on conflict.

### 2. Spec design (HOW)
- id: `design`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/design.md`
- access policy: worktree-relative

Architecture: primitive contract (layoutClassName layout-only slot + same-slice parent rule), no-mixed-ownership incl. descendant-selector case, preserved-CSS boundary, per-slice protocol.

### 3. Spec tasks
- id: `tasks`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/tasks.md`
- access policy: worktree-relative

Work breakdown. This workflow covers the self-contained subset of the Stage B feature waves (tasks 7.x) for catalog/config/composer/cockpit/spawn-card only.

### 4. Tailwind conventions + per-slice protocol
- id: `conventions`
- type: document
- locator: `docs/tailwind-conventions.md`
- access policy: worktree-relative

AUTHORITATIVE operational rules produced by Stage A: class rules, layoutClassName allowlist, max-* breakpoint convention, single-side-border gotcha, the per-slice migration protocol with fixed viewport dimensions, the preserved-CSS catalog. Follow it for every slice.

### 5. CSS ownership inventory
- id: `inventory`
- type: document
- locator: `docs/reports/css-inventory.md`
- access policy: worktree-relative

Stage A's owner -> taxonomy -> preserved-residual map. Use it to know which rules in a feature CSS file are migratable vs preserved.

### 6. CC design-system contract
- id: `design-system-skill`
- type: document
- locator: `.claude/skills/cc-design-system/SKILL.md`
- access policy: worktree-relative

The design-system contract; source for what parity-equivalent means.

### 7. Engineering steering
- id: `engineering-principles`
- type: document
- locator: `.kiro/steering/engineering-principles.md`
- access policy: worktree-relative

Type safety (no any/ts-ignore), Zod-first, dependency injection over vi.mock for internal modules. Always applies.