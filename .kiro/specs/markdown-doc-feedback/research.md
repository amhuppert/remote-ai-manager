# Research & Design Decisions

## Summary
- **Feature**: `markdown-doc-feedback`
- **Discovery Scope**: Extension (brownfield integration into the existing document viewer, conversation transcript, state store, and prompt pipeline)
- **Key Findings**:
  - Both markdown-viewing surfaces (`DocsPanel`, `SpecBrowser`) render through the **same** `MarkdownViewer` component, giving one injection point for styling + the comment layer.
  - Reference docs are keyed by an opaque SQLite id but carry a `filePath`; Kiro specs are path-only (`.kiro/...`). A **worktree-relative `docPath`** is the common identity for both content fetching and comment keying.
  - `@recogito/text-annotator` renders highlights as an **overlay** (no `<mark>` injection), which is compatible with React-owned react-markdown output. It does **not** do fuzzy re-anchoring or heading/line refs — those are built on top.
  - The conversation transcript is server-written; rendering a "feedback card" requires a structured content block, so the prompt pipeline must carry a structured payload (not just text).
  - The in-conversation markdown file card can be **derived at render time** from existing `tool_use` blocks — no new persisted block or transcript change needed.

## Research Log

### `@recogito/text-annotator` build-vs-adopt
- **Context**: The tech-stack note proposes `@recogito/text-annotator`; the prototype hand-rolls selection with a flat block model + `<mark>` wrapping that does not transfer to react-markdown's nested DOM.
- **Sources Consulted**: npm registry (`@recogito/text-annotator` 4.2.5, `@recogito/react-text-annotator` 4.2.5, published 2026-06-17, BSD-3-Clause), library source (spans/CSS-highlight renderers, W3C `TextQuoteSelector`/`TextPositionSelector` adapters), GitHub issue #233 (a11y gap).
- **Findings**:
  - Peer deps allow React 18/19 (`react`/`react-dom` `>= ^18 || >= ^19`); `openseadragon` peer is only for the image/PDF siblings (not needed for text).
  - Two renderers: SPANS (absolutely-positioned overlay div) and CSS_HIGHLIGHTS (native CSS Custom Highlight API). Neither mutates the text DOM.
  - Browser-only (selection ranges, client rects, `CSS.highlights`) → must be client-side; guard against SSR.
  - No automatic re-anchoring on document edits; quote/offset must match. No built-in DOM↔highlight association (a11y gap).
- **Implications**: Adopt recogito as the selection→highlight engine, dynamically imported in a `"use client"` component. Build on top: comment UI, heading/section/line references, persistence, exact-match re-anchoring. Provide minimal aria affordances on the comment markers/cards (the gutter pins and cards are real DOM and are keyboard-reachable).

### Document identity across surfaces
- **Context**: Comments must apply to both registry docs and Kiro specs and be document-scoped, not conversation-scoped.
- **Findings**: Reference docs (`reference_documents` table) have `id` + `filePath` (sometimes absolute). Specs have no id; addressed by `.kiro/steering/<f>.md` or `.kiro/specs/<feature>/<f>.md`. Content for both is read live from disk.
- **Implications**: Define a normalized **worktree-relative `docPath`** as the universal identity. Comments key on `(project_path, session_name, doc_path)`. A single generic content-by-path endpoint serves the viewer for any markdown file (registered, spec, or agent-written-but-unregistered), unifying the file-card "open by path" requirement (4.3) with the comment key (10.1).

### Transcript feedback rendering
- **Context**: Sent comments must render as a "Document feedback" card in the transcript (8.2) and reach the agent as text (8.1).
- **Findings**: The agent SDK receives a `prompt` string; the CC transcript user turn is written server-side during prompt execution. `MessageContentBlock` is a Zod discriminated union; adding a variant is the established extension pattern (cf. `image_ref`).
- **Implications**: Add a `document_feedback` content block. Extend the prompt request schema with an optional `documentFeedback` payload; when present, the execution path records a `document_feedback` block on the user turn and derives the agent-facing `prompt` text via a pure `formatDocumentFeedbackPrompt`.

### In-conversation markdown file card source
- **Context**: Cards triggered by Write/Edit on `.md` and by agent-registered docs (4.1, 4.2).
- **Findings**: `format-tool-use.ts` already parses `tool_use` blocks for Write/Edit/Read with file paths; `register_document` is itself an MCP `tool_use` with `input.file_path`. Card rendering can be derived from these at render time.
- **Implications**: No new persisted block for cards (YAGNI). `MessageContent` inspects `tool_use` blocks and renders a `MarkdownFileCard` when the tool is Write/Edit/register_document targeting a `.md` path. Clicking opens the file by `docPath` in the viewer.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Adopt recogito overlay | Use `@recogito/react-text-annotator` over rendered markdown | Cross-browser selection, W3C selectors, no DOM fight | New dep; manual re-anchor + a11y | Selected |
| Custom selection engine | Hand-roll like the prototype | Zero dep | Re-implements solved range/selection edge cases; `<mark>` fights React | Rejected |
| New persisted `markdown_ref` block for file cards | Externalize md refs like images | Explicit | Transcript-format churn; redundant with tool_use data | Rejected (derive at render) |
| Umzug migration for comments table | Ordered migration | — | Unnecessary for an additive new table | Rejected; use schema floor |

## Design Decisions

### Decision: Worktree-relative `docPath` as universal document identity
- **Alternatives**: (1) Reference-doc id; (2) per-surface identity.
- **Selected**: Normalize every document to a worktree-relative `docPath`; key content + comments on it.
- **Rationale**: Only common denominator across registry docs and specs; satisfies document-scoped comments (10.1/10.4) and "open by path" file cards (4.3).
- **Trade-offs**: Reference docs with absolute `filePath` must be normalized; same relative path could resolve under worktree vs project root for specs — comments key on the relative path and are stable across that choice.
- **Follow-up**: Centralize normalization + traversal guards in `src/lib/documents/path.ts`.

### Decision: Exact-match re-anchoring with stored content hash as "revision"
- **Alternatives**: (1) Fuzzy prefix/suffix; (2) revision snapshots.
- **Selected**: Store `docRevision` (content hash at creation) + char offsets + exact quote + prefix/suffix. On load, attempt exact match at/near offsets; on miss, mark `stale`.
- **Rationale**: Matches the locked v1 decision (exact-match only); prefix/suffix stored for future fuzzy upgrade without a schema change; avoids snapshot storage.
- **Trade-offs**: Minor edits drop a highlight to `stale` more readily; never mis-relocates (11.4).
- **Follow-up**: `anchor.ts` pure functions are the unit-test core.

### Decision: New `document_comments` table in the synchronous schema floor (no Umzug migration)
- **Selected**: Add `CREATE TABLE IF NOT EXISTS document_comments` to `state-db.ts`; no Umzug migration, no `KNOWN_SCHEMA_VERSION` bump.
- **Rationale**: Additive/forward-compatible new table is structural and must hold at open time; the floor runs idempotently on every connection (fresh/`:memory:`/contract fixtures included). No data backfill needed.
- **Trade-offs**: None material; older builds simply ignore the table (forward-compatible).
- **Follow-up**: Add a `*.contract.test.ts` durability backstop via `assertRoundTripDurability`.

### Decision: Generalize the conversation target picker from the existing prompt autocomplete
- **Selected**: Reuse `useAllConversationsQuery`, `filterAndScoreConversations`, and the `ui/Autocomplete` primitives; default to the most-recently-viewed conversation via the `cc-open-tabs` LRU tail, falling back to most-recent-by-activity.
- **Rationale**: Honors "similar to the prompt-input autocomplete" + all-conversations scope (9.1) without duplicating filter/scoring logic.
- **Trade-offs**: Picker depends on the existing recency signal; if absent, falls back to activity recency.

## Validation Remediation (kiro-validate-design NO-GO, 2026-06-27)

An independent design-validation review (Codex) returned NO-GO with three contract gaps; all three were accepted and resolved in `design.md` + `tasks.md`:

1. **Target identity too thin.** The picker lists conversations cross-project, but prompt/queue routes are project/session-scoped and the design stored only a conversation id. Resolved: introduced `DocumentFeedbackTarget` (project, projectPath, session, conversation, backend, status), derived from the `ConversationListItem` the picker holds; the send orchestration constructs the sender from the full target identity, and "start a new conversation" (9.5) targets the document's own session. (design: Shared types, Feedback send routing, store field; tasks 6.1, 6.2.)
2. **Queue path dropped the structured block.** Only the immediate-send schema was extended, so queued feedback (8.4) would deliver text but render no card (8.2). Resolved: `documentFeedback` is first-class in the enqueue schema, the durable pending-queue entry, and live/next-turn delivery + transcript append; the `conversations` durability contract is extended. (design: Prompt pipeline extension, modified files, Data Contracts; new task 7.2, deps on 8.5/9.1.)
3. **Absolute reference-doc path policy unresolved.** Registered docs may be absolute while the new endpoint is worktree-scoped. Resolved: absolute-inside-worktree normalizes to relative; absolute-outside-worktree is unavailable (404 + explicit UI state); legacy per-id endpoint left intact. (design: content handler, path.ts, error handling; tasks 1.6, 2.2, 8.2.)

The re-review confirmed those three were resolved and returned NO-GO on two further points, both accepted and resolved:

4. **Selection anchoring under-specified for cross-block selections.** The anchor models offsets within one block, but Req 5.1 ("contiguous passage") did not bound selections to a block. Resolved by choosing the prototype's behavior: **v1 anchors within a single rendered block; cross-block selections are rejected** (affordance not shown). Reflected in design Out of Boundary, the `anchor.ts` contract, `AnnotatedMarkdown`/selection handling, requirements Out-of-scope, and tasks 4.3. The anchor model intentionally carries no end-block identity (multi-block deferred).

5. **Recogito dependency set likely incomplete (`openseadragon` peer).** The React wrapper imports `@annotorious/react`, whose index eagerly references OpenSeadragon. Resolved by adding `openseadragon` as an explicit dependency AND making task 1.1 a real install/build spike that proves it bundles under Next/Bun. (Alternative considered: drop to the vanilla `@recogito/text-annotator` core + a thin custom React binding to shed `@annotorious/react`/TEI/OSD — deferred as a bundle-size follow-up; keep the wrapper for v1.)

Non-blocking hazards the reviewer flagged were folded into task detail: `MultiEdit` counts as an edit for file cards (with de-dup); cards must survive grouped/collapsed tool-use rendering; the existing Mermaid handling must survive the plain-code-block restyle; the new content endpoint uses a `{ content, docPath }` schema distinct from the shared `{ content }`.

The third review confirmed those were resolved and returned NO-GO on two further (narrow) points, both accepted and resolved:

6. **Feedback payload not threaded through the conversation actor + queue drain.** The send funnel reduces every prompt to `promptText`+`images`: the `SUBMIT_PROMPT` event / `ExecutePromptInput` carry only those, `build-user-transcript-blocks.ts` emits only text/image blocks, and `queuedBatchToSubmitPrompt` (`manager.ts`) drops all non-text/image blocks on drain. So the prior route-handler-level fix could not actually emit a `document_feedback` block. Resolved: `documentFeedback` is threaded through the request boundary → `SUBMIT_PROMPT` event + `ExecutePromptInput` → user-turn block construction (emit `document_feedback`, derive text) → durable queue content + `queuedBatchToSubmitPrompt` (no longer drops the block) → actor/drain tests + conversations durability contract. (design: Prompt pipeline extension, modified files, revalidation triggers; tasks 7.1, 7.2.)
7. **Registered-doc detection used the wrong MCP tool-name shape.** `tool_use.name` stores the full `mcp__<server>__<tool>` (e.g. `mcp__cc-session-tools__register_document`), not bare `register_document`. Resolved: detection normalizes the name (strip `mcp__<server>__` prefix, match bare `register_document`, accept the bare form too) with unit coverage. (design: `markdown-file-refs.ts` contract; tasks 1.6.)

The fourth review confirmed those were resolved and returned NO-GO on three integration gaps, all accepted and resolved:

8. **`useSendPrompt` is not a safe cross-target transport.** It mutates the *mounted* conversation's optimistic Zustand store and gates `queue()` on the mounted view's `sending` flag, so reusing it for a different target misroutes UI state / skips queueing. Resolved: `useSendDocumentFeedback` issues **target-aware low-level POSTs** directly to the target's `/conversations/[id]/prompt` and `/queue` endpoints (new conversation → document's-session prompt endpoint), without touching the mounted optimistic store, plus an immediate→queue race fallback if the target turned running. `use-send-prompt.ts` is now left unchanged. (design: Feedback send routing, modified files; tasks 6.2.)
9. **Codex `run_codex` reference documents missed.** Codex registers `referenceDocuments` (embedded as JSON in the `run_codex` tool_result content, `{ filePath, description }[]`) without a `register_document` call. Resolved: `extractMarkdownFileRefs` also reads the paired `run_codex` tool_result (correlated by tool_use_id), `safeParse`s its content, and emits `.md` reference-doc cards. (design: `markdown-file-refs.ts` contract, unit tests; tasks 1.6.)
10. **Comment mutation scope under-specified.** PATCH/DELETE by id did not verify scope, so a known id could mutate a comment in another session. Resolved: a scoped `findByIdInScope(projectPath, sessionName, id)` repo method + handler ownership chain (project→session) → out-of-scope id returns 404. (design: repo contract, route table, Security, tests; tasks 1.4, 2.1, 9.1.)

Re-validation (`/kiro-validate-design markdown-doc-feedback`) is pending on the four-times-revised artifacts.

## Risks & Mitigations
- **Recogito SSR / React reconciliation** — Dynamic-import the annotator in a client-only component; mount it against the rendered container after render and re-measure on content/tab change.
- **Highlight geometry drift on re-render/scroll** — Re-sync recogito on document switch and content load; key the annotated container per `docPath`.
- **Prompt-pipeline coupling** — Keep the `documentFeedback` payload optional and additive; existing text/image sends are unchanged. Mark prompt schema + message-content schema as revalidation triggers.
- **a11y gap in overlay highlights** — Gutter pins and comment cards are real, keyboard-reachable DOM with labels; highlights are decorative.
- **Path traversal via docPath** — Strict worktree-relative validation + `.md`-only guard in the content endpoint and comment writes.

## References
- [@recogito/text-annotator (npm)](https://www.npmjs.com/package/@recogito/text-annotator) — 4.2.5, BSD-3.
- [@recogito/react-text-annotator (npm)](https://www.npmjs.com/package/@recogito/react-text-annotator) — React 19 peer support.
- [recogito/text-annotator-js (GitHub)](https://github.com/recogito/text-annotator-js) — renderers, W3C selectors, issue #233 (a11y).
- Internal: `.kiro/steering/tech.md` (DB migration layers), `PERFORMANCE.md` (focused accessors/setters), `docs/tailwind-conventions.md`, `.claude/skills/cc-design-system`.
