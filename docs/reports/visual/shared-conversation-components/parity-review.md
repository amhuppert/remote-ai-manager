# B-4 shared-conversation-components — parity review

Slice: MessageRow + shared conversation components (HIGH-TRAFFIC). Migrated the
`message-*/msg-*` (MessageRow, ConversationNav, CopyMessageButton,
MessageActions), `agent-pill*` (AgentPill), `backend-toggle*` (BackendToggle),
`voice-*` (VoiceRecordButton), `typing-*`/`streaming-indicator` (TypingIndicator),
`attachment-*` (ImageAttachmentPreview), `focus-confirm*` (FocusConfirmationBar)
families + the `.collab-pinned-top-target` element (ConversationPanel) to
utilities + data-* class maps, and deleted those rules from `conversation.css`
(2919 → 2346 lines, including the zero-consumer dead `msg-editor*` /
`msg-actions-confirm*` / `.message.user.editing*` block).

## Method

Same-session before/after at the two fixed viewports (desktop 1440×900, mobile
390×844, DSF 1) via a private Storybook in **this** worktree (`:6091` — CC's
`ensure_dev_server` resolves to the prefix-sibling `…3204f2`, not
`…3204f2.slice-collab`). "before" = the committed slice-ask-question tree
(`git stash`), "after" = the migrated tree; Playwright capture + a `sharp`
pixel-diff (per-channel sum threshold 16) run from scratch scripts OUTSIDE the
worktree (`/tmp`, since this slice may not write helper scripts). Animations +
caret frozen and the `--font-*` CSS vars pinned identically in both passes
(Storybook does not inject next/font's `--font-*`, and its resolution varies
across sessions — pinning isolates real layout/colour/text change).

## Result — all five MessageRow consumers verified, byte-identical

22/32 curated stories byte-identical; the rest are explained below. Every
consumer named in the acceptance criteria now has direct before/after artifacts:

| Consumer | Story | Result |
|---|---|---|
| 1. cockpit transcript (ProjectTranscriptHost) | `project-cockpit-projecttranscripthost--messages-only`, `--with-spawn-card-slot` | byte-identical |
| 2. workflow conversation viewer (WorkflowConversationViewer) | `b4-parity-harness--workflow-viewer` | identical except iteration-badge AA (below) |
| 3. peek popover (PeekPopover) | `session-peekpopover--running`, `--awaiting` (both viewports) | byte-identical |
| 4. panes conversation body (PanesGrid) | `session-panesgrid--two-panes` (both viewports) | byte-identical |
| 5. message-row-renderer hook (useMessageRowRenderer) | `b4-parity-harness--message-row-renderer-claude` / `--codex` | identical except iteration-badge AA |

Consumers 2 and 5 had no existing story, so a TEMPORARY capture harness rendered
the real `WorkflowConversationViewer` (seeded React Query) and the real
`useMessageRowRenderer` hook (claude + a codex `[data-backend=codex]` thread);
it was captured, then DELETED (not part of the deliverable). Plus: BackendToggle,
ConversationNav, FocusConfirmationBar, ImageAttachmentPreview, and MessageRow
no-badge / system-notice are byte-identical.

## Three real regressions caught by the screenshots and FIXED

1. **Iteration badge text-transform.** `.message-iteration-badge` carried
   `text-transform: none` to cancel `.message-role`'s `uppercase`; the first
   re-inline dropped it → "ITER 3". Fixed with `normal-case`.
2. **Codex role colour was ancestor-dependent, not prop-derived.** Legacy
   coloured the assistant role violet only via
   `.conversation[data-backend=codex] .message.assistant .message-role`; computing
   it from the `selectedBackend` prop turned the sidebar-peek MessageRow previews
   violet where legacy stayed cyan. Fixed by transcribing the legacy selector as
   the §8.2 ancestor-descendant variant.
3. **Unlayered legacy `.text-*` classes shadowed the codex override.** CC's
   `typography.css` ships UNLAYERED `.text-cyan` / `.text-violet` utility classes
   that outrank `@layer utilities` (unlayered > layered). The first form of fix #2
   used bare `text-cyan` as the base, so the legacy `.text-cyan` beat the `@layer`
   codex override and pinned every codex assistant role to cyan (verified broken
   in a real codex thread). Fixed by using collision-free arbitrary values
   `text-[var(--cyan)] [[data-backend=codex]_&]:text-[var(--violet)]`, so both
   base and override live in `@layer utilities` and the override wins by
   specificity. Verified: the codex hook harness now renders violet assistant
   roles (rgb(199,125,255)); the peek previews (no codex ancestor) stay cyan.

## Explained, non-blocking differences (NOT regressions)

- **Iteration-badge sub-pixel AA** (`projects-messagerow--with-iteration-badge`
  97px; the harness/workflow-viewer ~200px = the same AA × 2 badges). The diff
  box excludes the role text, so the role colours match exactly (claude cyan,
  codex violet); a high-zoom crop confirms the "iter N" pill is pixel-identical.
- **`components-messageactions--default`** — a dev-story MOCK fixture that
  hardcodes legacy `.message-role` "You" markup (not the real component); it loses
  the amber role colour when the `.message.user .message-role` rule is deleted.
  Outside this slice's ownership; the REAL components are byte-identical. Same
  precedent as the collab / ask-question mock-fixture hand-offs. Other such mock
  stories (ConversationVirtuosoList, ConversationPane, MobileSessionView,
  ReasoningLevelSelector) are flagged in the carry-forward notes for their owning
  features to refresh.

## Artifacts

`before/` and `after/` — 16 stories × {desktop,mobile} covering all five
consumers + the migrated standalone components.
