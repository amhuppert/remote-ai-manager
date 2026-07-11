# Implementation Tasks

- [x] 1. Establish canonical Markdown detection and locator contracts
- [x] 1.1 Add failing tests for `Read` detection, origin labels, case-insensitive `.md`, deduplication, and unchanged non-Markdown filtering in `src/lib/documents/markdown-file-refs.test.ts`
  - Extend the origin schema/type with `read`; preserve Write/Edit/MultiEdit/register/run_codex behavior.
  - _Requirements: 1.1–1.6_
- [x] 1.2 Add failing path tests for canonical worktree and external locators, relative escape resolution, malformed/non-Markdown rejection, and stable absolute normalization
  - Implement `normalizeMarkdownLocator` as the single browser/server identity helper while retaining a confined helper for call sites that still require worktree-only paths.
  - _Requirements: 6.1, 6.5, 6.6_
- [x] 1.3 Add Zod schemas for persisted session Markdown documents and unified list items
  - Derive all types with `z.infer`; add schema round-trip and rejection tests.
  - _Requirements: 2.1–2.3, 3.3_

- [x] 2. Persist the session Markdown document index
- [x] 2.1 Add failing state DB and repository contract tests
  - Cover fresh-table creation, row round-trip, session/path isolation, newest-first ordering, conflict updates preserving `firstSeenAt`, and session cascade deletion.
  - _Requirements: 2.1–2.5_
- [x] 2.2 Add the additive `session_markdown_documents` floor table and repository
  - Implement parsed row mapping, prepared statements, bulk transaction upsert, exact-path lookup, and structured timing logs.
  - _Requirements: 2.1–2.6_
- [x] 2.3 Wire focused state-store accessors/setters and public exports
  - Use the serialized write queue; update state-store dependency schemas and focused-read tests without adding the index to `SessionState` blobs.
  - _Requirements: 2.1–2.5_

- [x] 3. Index Markdown activity at transcript persistence
- [x] 3.1 Add failing transcript tests for indexing before broadcast, one bulk upsert per entry, session-wide identity, project-sentinel skip, and non-fatal index failure
  - Exercise production logic through dependency injection; do not mock internal project modules.
  - _Requirements: 1.1–1.5, 2.1–2.7, 3.8_
- [x] 3.2 Implement `session-index.ts` and extend transcript dependencies
  - Resolve project/session scope, canonicalize extracted refs, deduplicate, bulk upsert, and emit content-free structured logs; catch failures after transcript append and before SSE broadcast.
  - _Requirements: 2.1–2.7_

- [x] 4. Provide the unified document list and authorized content reads
- [x] 4.1 Add failing pure tests for merging indexed and registered documents
  - Cover canonical deduplication, registered metadata, external location, latest origin/timestamps, and stable most-recent ordering.
  - _Requirements: 3.1–3.3, 6.3–6.4_
- [x] 4.2 Add failing route tests for the list endpoint and external authorization
  - Prove exact-session ownership; registered-only external access; indexed external access; unauthorized external rejection before `readFile`; internal worktree access; non-Markdown/missing/unexpected error mapping.
  - _Requirements: 3.1–3.3, 6.3–6.7_
- [x] 4.3 Implement the unified list service, route, thin App Router shell, and content-route authorization
  - Keep the existing content URL; validate responses with domain schemas; log failures without contents.
  - _Requirements: 3.1–3.3, 6.3–6.7_
- [x] 4.4 Add React Query keys/hooks and live invalidation
  - Add `useMarkdownDocumentsQuery`; inspect session-scoped `message-appended` blocks and invalidate only when the pure extractor finds Markdown refs.
  - _Requirements: 3.8_

- [x] 5. Replace the Docs browse source with the durable list
- [x] 5.1 Add failing component tests for populated, registered-description, external, active, loading, empty, error, and row-open behavior
  - Test keyboard activation and full accessible names; retain browse/viewer nonce behavior.
  - _Requirements: 3.4–3.8, 7.3–7.5_
- [x] 5.2 Implement `MarkdownDocumentList` and integrate it into `DocsPanel`
  - Use utilities/primitives only; active selection uses elevation plus cyan border; external items remain enabled; mobile rows meet 44px.
  - _Requirements: 3.4–3.7, 7.1–7.5_
- [x] 5.3 Add colocated Storybook stories
  - Cover populated mixed-origin/external, empty, loading, and error variants using the presentational list boundary.
  - _Requirements: 7.6_

- [x] 6. Open Markdown files directly from autocomplete
- [x] 6.1 Add failing `FileAutocompleteList` and popup tests
  - Cover Markdown-only Open visibility, pointer propagation, prompt preservation, popup close, `Alt+Enter`, accessible labels/tooltips, and unchanged row/Enter/Tab insertion.
  - _Requirements: 4.1–4.7, 7.4–7.7_
- [x] 6.2 Implement the Open action and viewer wiring
  - Extend list item/callback contracts minimally; use `IconButton` plus a 1.5-stroke SVG; stop mouse/pointer propagation and prevent blur; route through `openDocument`.
  - _Requirements: 4.1–4.7_
- [x] 6.3 Extend `FileAutocompleteList.stories.tsx`
  - Add mixed Markdown/non-Markdown results and visible Open actions; keep existing loading/empty/error stories.
  - _Requirements: 7.6_

- [x] 7. Open inserted Markdown chips before sending
- [x] 7.1 Add failing chip tests for open/remove separation, prompt immutability, Markdown-only behavior, Enter/Space activation, and focus/accessibility
  - Render production node-view behavior through the document scope and session store.
  - _Requirements: 5.1–5.5, 7.7_
- [x] 7.2 Implement sibling body/remove controls in `FileMentionChip`
  - Canonicalize the worktree path, open through the existing store, preserve Tiptap serialization, and keep non-Markdown chips inert.
  - _Requirements: 5.1–5.5_
- [x] 7.3 Add an openable Markdown chip Storybook story
  - Use a small presentational boundary if required to avoid fabricating Tiptap internals in Storybook.
  - _Requirements: 7.6_

- [x] 8. Enable external transcript cards and read-only viewing
- [x] 8.1 Replace the existing unavailable-card test with failing external-open tests
  - Assert canonical absolute identity, active Docs routing, tab deduplication, registered external list opening, and missing-file error state.
  - _Requirements: 6.1–6.3, 6.7_
- [x] 8.2 Add failing viewer tests that external documents mount Markdown content without comment queries, annotations, comment actions, or feedback controls
  - Confirm worktree documents retain the full review surface.
  - _Requirements: 6.8–6.9_
- [x] 8.3 Implement actionable external cards and the read-only viewer branch
  - Show `EXTERNAL`/`READ ONLY` metadata; keep the common header, tabs, activation flash, and content errors.
  - _Requirements: 6.1–6.9, 7.1–7.5_

- [x] 9. Validate the integrated feature
- [x] 9.1 Run focused Vitest suites after every red-green slice, then the complete related document/prompt/transcript/state-store test set
  - _Requirements: 1–7_
- [x] 9.2 Run `bun run typecheck`, `bun run lint`, and Storybook tests/smoke for the changed stories
  - Fix only regressions attributable to this feature; report unrelated failures with evidence.
  - _Requirements: 7.1–7.7_
- [x] 9.3 Run live UI verification in this worktree
  - Use `cctl dev ensure` before browser or Next.js tooling; verify Docs accumulation across conversations/reload, autocomplete row vs Open behavior, chip opening, external registered/transcript cards, mobile touch targets, keyboard paths, console errors, and network authorization failures.
  - _Requirements: 2.4–2.5, 3.4–3.8, 4.1–4.7, 5.1–5.5, 6.1–6.9, 7.3–7.7_
