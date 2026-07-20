# Claude Design prompt — Quick Ticket dialog + CC bug-report mode

Copy everything below the rule into Claude Design.

---

Design and prototype the **Quick Ticket** experience for Command Center: a global, low-friction ticket-creation dialog with a specialized **Command Center bug-report mode**. You have the codebase — read the referenced files before designing, and follow the design system exactly.

## Product context

Command Center (CC) is a control plane for running Claude/Codex agent sessions in isolated git worktrees. Its ticket system treats tickets as **context bundles designed for agents**: a ticket carries typed attachments (file snapshots, conversation compaction snapshots, session pointers, related tickets, markdown notes), and every attachment's description plus a retrieval command forms an index that implementing agents navigate via the `cctl` CLI.

The problem: today tickets are created from the /tickets page or by an agent via `/ticket`. When an idea or bug observation arises mid-work — say, while reading a conversation — there's no way to capture it without leaving the current context. The quick-ticket dialog fixes that: open from anywhere, confirm prefilled context, create, and be back in flow in seconds. The CC bug-report mode turns the same dialog into a self-assembling diagnostic bug report for Command Center itself.

## Read these first

- `.claude/skills/cc-design-system/SKILL.md` and `docs/tailwind-conventions.md` — binding design-system and styling rules.
- `src/features/tickets/components/CreateTicketDialog.tsx` — the existing creation dialog. You are **evolving this into the canonical dialog**, not designing a parallel surface.
- `src/components/ui/Dialog.tsx` + `src/components/ui/dialog-recipe.ts` — dialog primitive: sizes (default 480px / wide 720px), scrim, motion, and the mobile bottom-sheet variant.
- Form/UI primitives in `src/components/ui/`: `FormField`, `Select`, `Autocomplete`, `SegmentedControl`, `Checkbox`, `Switch`, `Button`, `IconButton`, `Badge`, `StatusChip`, `Spinner`, `Tooltip`, `Collapsible`, `SectionHeader`, `EmptyState`.
- `src/components/Topbar.tsx` — global topbar with breadcrumb switchers (⌘P project, ⌘J session). The new entry button lives here.
- `src/lib/tickets/schemas.ts` — ticket fields: title, markdown description, workType (feature/bug/research/tech_debt/performance), status, one project, attachments.
- `src/features/tickets/components/AttachmentIndex.tsx` — how attachments render today (useful vocabulary for the bundle panel).

## Locked UX direction — do not re-litigate

1. **Entry points**: a persistent compact affordance in the global topbar + a global hotkey (assume ⌘⇧T; final combo is vetted separately). Available on every page except the config surface.
2. **One canonical dialog**: the evolved `CreateTicketDialog` serves every creation path, including the /tickets page button.
3. **Context prefill**: project prefilled from the current route; when a conversation is active in view, it appears as a **removable chip** in a Context section. On pages with no project context the project field starts empty — never guess. Prefill is a proposal; everything stays editable.
4. **Create is instant** (no LLM in the path): dialog closes, a toast confirms with a "View ticket" action, the user stays exactly where they were. The attached conversation's compaction snapshot generates in the background — no waiting state in the dialog.
5. **CC bug mode is a mode switch inside the dialog.** Flipping it retargets the ticket to the Command Center project, sets type = bug, and reveals a **diagnostic bundle panel**. Title/description remain the user's own words.
6. **Diagnostic bundle** — seven auto-captured items, every one **visible before submit and individually removable** (nothing is attached invisibly):
   - Current route + view state (URL, selected conversation, active pane)
   - Identity IDs + deep links (project, session, conversation IDs, active workflow execution)
   - Conversation attachment (compaction snapshot of the active conversation)
   - cctl command crib (ready-to-run commands for the implementing agent)
   - Server build + environment (build stamp/SHA, version)
   - Screenshot of the page as it looked before the dialog opened (thumbnail preview in the panel)
   - Recent client errors (last N console/network errors)
7. **Unresolvable CC project**: on instances where the Command Center project can't be resolved, the mode switch renders **disabled with an explanatory tooltip** — not hidden.
8. **Draft safety**: accidentally dismissing a dirty dialog must not lose typed text.

## What to design and prototype

Build a working high-fidelity prototype with realistic sample data (e.g. project "command-center", a conversation titled something plausible, a real-looking bundle). Cover:

1. **Generic mode** — prefilled state (project + conversation chip), chip removed, and the empty-project state on a global page.
2. **CC bug mode** — the mode switch, the bundle panel with all seven items, an item removed, the screenshot thumbnail, and the disabled-switch state with its tooltip.
3. **Topbar affordance** — placement and form next to the existing breadcrumb chrome; must read as quiet, permanent chrome, not a promoted CTA.
4. **Success toast** — with the "View ticket" action.
5. **Transient states** — submitting (pending button), create failure, and your chosen draft-safety interaction.
6. **Keyboard flow** — hotkey opens with focus in the title field; sensible tab order; a submit shortcut (e.g. ⌘Enter); Escape behavior with dirty fields consistent with your draft-safety choice.
7. **Mobile** — the bottom-sheet variant per the dialog recipe; the bundle panel must stay usable at sheet width.

## Interaction decisions delegated to you

- The mode switch's form (SegmentedControl vs toggle vs something better) and its placement in the dialog.
- Bundle panel layout: checklist, dismissible rows, or chips; how much inline preview each item gets (e.g. expandable detail for the metadata note, thumbnail size for the screenshot).
- The conversation-link chip's design and its remove affordance.
- Draft safety mechanism: restore-on-reopen vs confirm-before-discard.
- Whether the /tickets-page invocation keeps its current navigate-to-detail on success or adopts the toast.
- Dialog width (default vs wide) per mode, and how the bundle panel appears/disappears on mode flip without the dialog feeling jumpy.

## Constraints

- Existing primitives and tokens only — no new colors, fonts, or one-off components where a primitive fits. Match the design system's tone: calm, dense, engineered.
- Single screen, no wizard. The only text the user must type is the title. Speed is the product: target "open → type title → ⌘Enter" as the happy path.
- The bundle panel must inform without overwhelming — the generic mode's simplicity is sacred; CC bug mode adds a panel, not a different dialog.
- Don't design: the ticket detail page, the background enrichment job's UI, backend behavior, or the screenshot-capture mechanism.
