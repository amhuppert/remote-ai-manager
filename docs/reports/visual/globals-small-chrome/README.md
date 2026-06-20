# Stage B-5a — small globals.css chrome parity (link-chip, page-header, collapsible-text)

Byte-identical before/after evidence for the three single-owner globals.css chrome
surfaces migrated in this slice. Method: deterministic capture (private Storybook
:6019 for the two storyable components; private Next `/projects` for the page header),
"before" = legacy classes + globals.css rules restored via `git stash`, "after" =
migrated utilities. Viewports per `docs/tailwind-conventions.md`: desktop 1440×900,
mobile 390×844.

| Surface | Component | Stories / view | Result |
|---|---|---|---|
| Collapsible Text | `CollapsibleText.tsx` | Long, CustomHeight × desktop/mobile | byte-identical |
| Conversation Link Chip | `ConversationLinkChip.tsx` | Default, LongName, CodexBackend × desktop/mobile | byte-identical |
| Page Header | `ProjectsIndexPage.tsx` | `/projects` header crop × desktop/mobile | byte-identical |

All before/after PNG pairs match by sha256 (verified `shasum -a 256`), including the
`data-[backend=codex]:border-violet-dim` chip variant and the page title's responsive
`max-768:text-[1.6rem]` shrink. Zero visual change.

Note: the first page-header "before" capture was discarded — a Next CSS-HMR staleness
artifact (legacy `.accent` span rendered against the not-yet-recompiled stylesheet);
re-captured after a forced recompile, then byte-identical.
