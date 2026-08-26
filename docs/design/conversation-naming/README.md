# Conversation Auto-Naming — Implementation Plan

Status: decision-complete, ready for implementation. Objective clarified with Alex 2026-08-04 (question batch `q_a88e049f`).

## Locked product decisions (from Alex)

1. **Scope**: all user-facing conversations (session + project scope) auto-name from their first user message. Forks keep `Fork of X @ turn N`. Workflow-internal/ephemeral actors never auto-name. No backfill of existing conversations.
2. **Placeholder**: keep the existing deterministic creation defaults (`<session> N`, `<project> chat N`) until the LLM name lands.
3. **Regenerate (whole conversation)**: reads the fresh compaction artifact when it covers the transcript, else a bounded compact transcript render.
4. **Manual names**: automatic generation never overrides them; the explicit regenerate action MAY replace them.
5. **Surfaces**: regenerate lives in the shared right-click menu (sidebar rows + tabs). Per-message "name from this message" button ships in v1 in the message hover actions.
6. **Config**: `conversationNaming` block in **global config.json only** (no per-repo override), surfaced in the settings UI.

## Decisions made in this plan

| Decision | Choice |
|---|---|
| Provenance | New persisted enum `nameOrigin: "default" \| "auto" \| "manual"` on both conversation tables. Rename APIs set `manual`; generation sets `auto`; creation leaves `default`. Existing rows decode as `default` (harmless — auto only fires on a conversation's first turn). |
| LLM call layer | Raw `getTaskRunner(backend).run(...)` with `executionProfile: "isolated-one-shot"` (the `generateSessionName` / ticket-enrichment precedent). NOT `executeWorkflowTaskRun` — that serializes on the conversation actor and writes transcript entries; naming must not touch the transcript. |
| Trigger seam | New machine entry action `triggerAutoNaming` in `acquiringResources` (beside `markReadOnUserTurnStart`), routed through the persistence adapter (durable impl fires, ephemeral no-ops). |
| Trigger guards | `activeTurn.kind === "conversation_turn"` && `!activeTurn.autonomous` && `role === null` && `promptCount === 0` && `forkedFrom === null` && non-empty prompt text && config `enabled`. |
| First-message basis | `context.activeTurn.promptText` truncated to 4 000 chars — no transcript read needed. |
| Race safety | Module-level single-flight map keyed by conversationId + write-time guard: auto-apply only while `nameOrigin === "default"`. |
| Kill switch | `enabled: boolean` (default true) in the config block. Gates ONLY automatic naming; the explicit buttons always work. |
| Config defaults | `{ enabled: true, backend: "claude", modelSelection: { modelId: "haiku", parameters: {} }, timeoutMs: null }`; service resolves `timeoutMs ?? 60_000` (never unbounded). The selection is an atomic catalog variant. |
| Output contract | `outputSchema: { name: string }` (structured output); fallback = first non-empty line of `result.text`. Sanitize: strip wrapping quotes/backticks, collapse whitespace, strip trailing `.`/`:`, truncate to 200 chars (the rename schema max). Empty after sanitize = failure. Prompt asks for 2–6 words, Title Case, same language as content. |
| Failure UX | Auto: silent — keep placeholder, structured warn log. Explicit: route returns the error; client shows a toast (`pushToast`, the tickets pattern). |
| Explicit API | `POST .../generate-name` (session + project routes), body `{ source: "conversation" } \| { source: "message", messageIndex }`. Handler AWAITS generation (bounded by timeout) and returns `{ name }` — gives the button real error handling; no new SSE event needed. |
| UI propagation | Existing `conversation-renamed` SSE event + existing client reactions. Mutation `onSuccess` also patches caches directly with the returned name. |
| Regenerate content budgets | Conversation basis: artifact markdown or compact render, 24 576 bytes. Message basis: `renderCompactTranscript` messageRange N:N, `includeTools: "none"`, 16 384 bytes. |
| Menu item | `Regenerate Name` immediately after `Rename…` in `conversation-row-menu.tsx`, hidden when no handler (existing optional-handler pattern). No ellipsis (acts immediately), no per-row spinner in v1. |
| Per-message button | New self-contained `GenerateNameFromMessageButton` (like `CopyMessageRefButton`), shown for both roles whenever `compactionTarget` is present; hand-authored 12×12 inline SVG icon (no icon library exists). |
| Known non-triggers (accepted) | First messages via `/collab` or slash-commands (`/commit` etc.) bypass `SUBMIT_PROMPT` → no auto-name. A command as a first message is a poor naming basis anyway. |

---

## Slice 1 — `nameOrigin` provenance field (persistence end-to-end)

**Red**: extend both maximal contract fixtures with `nameOrigin: "auto"` → schema parse fails.

1. `src/lib/conversations/schemas.ts` — above `conversationStateSchema`: `export const nameOriginSchema = z.enum(["default", "auto", "manual"])` + type; in `conversationStateSchema` after `name` (:226): `nameOrigin: nameOriginSchema.default("default"),`.
2. `src/lib/state-store/state-db.ts` — add `name_origin TEXT NOT NULL DEFAULT 'default' CHECK (name_origin IN ('default', 'auto', 'manual'))` to BOTH `CREATE TABLE` blocks (`conversations` :1064-1099 after `name`; `project_conversations` :1106-1144) AND two `ADDITIVE_COLUMNS` entries (template: `spec_revisions.authoring_stage` :1612-1616). **No numbered migration, no `KNOWN_SCHEMA_VERSION` bump** (purely additive with default).
3. `src/lib/state-store/conversation-row-codec.ts` — five symmetric edits: `SharedConversationRawColumns` (+`name_origin: string`), `decodeSharedConversationColumns` (enum `safeParse` guard in the `status`/`source` style :193-211, then `nameOrigin` in the candidate :327), `SharedConversationBindColumns`, `encodeSharedConversationColumns` (:584), `CONVERSATION_COLUMN_MAP` (+`["nameOrigin", "name_origin", (c) => c.nameOrigin]` :638).
4. `src/lib/state-store/conversations-repo.ts` — row schema :162 (+`name_origin: z.string()`), `SqlBindRow` :199, `CONVERSATION_COLUMN_KEYS` :330, upsert SQL (columns/VALUES/ON CONFLICT :453/:461/:472).
5. `src/lib/state-store/project-conversations-repo.ts` — same four spots (:103, :147, :202, :352/:361/:372). Bind spread covers encoding.
6. Origin transitions: `renameConversation` (`src/lib/conversations/service.ts:297`) and `renameProjectConversation` (`src/lib/project-conversations/service.ts:154`) additionally set `nameOrigin = "manual"`. `createProjectConversation` (:112-141): caller-supplied `opts.name` ⇒ `"manual"`. All other creation sites rely on the schema default (verify `buildConversation` parses through the schema).

**Tests**: both contract fixtures + `ALL_COLUMNS` (+`"name_origin"`, conversations contract :407-437); new `src/lib/conversations/name-origin.durability.test.ts` modeled on `creation-request-id.durability.test.ts` (seed → rename → `recreateStore()` → reload asserts `manual`); service tests for the three transition sites. No `fieldPolicies` entry (field is persisted); no blob-bounds discharge (scalar enum).

## Slice 2 — `conversationNaming` config block + settings section

1. `src/lib/config/schemas.ts` — `conversationNamingConfigSchema = z.object({ enabled: z.boolean().default(true), backend: agentBackendSchema.default("claude"), modelSelection: backendModelSelectionSchema.default({ modelId: "haiku", parameters: {} }), timeoutMs: z.number().int().positive().nullable().optional() })` + raw twin (all optional) + `export const resolveConversationNamingConfig = (config) => conversationNamingConfigSchema.parse(config.conversationNaming ?? {})`. Register in `globalConfigSchema` and `rawGlobalConfigSchema`. **NOT** in `perRepoConfigSchema`, no cascade helper.
2. `src/lib/config/loader.ts` `defaultConfig()` — block after compaction (:195-201).
3. `src/features/config/sections/NamingSection.tsx` — mirror `CompactionSection.tsx`: `SettingsPage title="Conversation" accent="naming"`; `ConfigToggle` (enabled), catalog-driven atomic model-selection controls, and `ConfigNumericInput` for timeout (`displayAsMinutes`, hint "Empty = 1 minute default"). Backend changes apply that catalog's complete default selection.
4. `src/features/config/ConfigPage.tsx` — import + `ConfigNavSection` union + `CONFIG_NAV` `{ id: "naming", label: "Naming" }` + `TabsContent` block (four edits, :23/:32-39/:44/:180-188 pattern).
5. `src/features/config/form-state.ts` — four `ALL_FIELD_PATHS` entries: `conversationNaming.enabled/.backend/.modelSelection/.timeoutMs`. (`use-config-form.ts` is generic — no edit.)

**Tests**: `schemas.test.ts` (defaults materialize; raw accepts partial), `NamingSection.test.tsx` mirroring `CompactionSection.test.tsx` (heading, atomic defaults, backend selection reset, parameter update, timeout minutes→ms, clear→null), `form-state.test.ts` if it enumerates paths.

## Slice 3 — naming service + content resolution

**`src/lib/conversations/name-generation.ts`** (new):

- Constants: `NAME_MAX_LENGTH = 200`, `FIRST_MESSAGE_BUDGET_CHARS = 4_000`, `DEFAULT_NAMING_TIMEOUT_MS = 60_000`; JSON `CONVERSATION_NAME_OUTPUT_SCHEMA` (`{ name: string }`, required, no additional props) + zod twin for `validateStructuredOutput`.
- `buildNamingPrompt(basisLabel, content)` — pure; rules: 2–6 words, Title Case, no quotes/trailing punctuation, same language, topic/goal not participants; content fenced.
- `sanitizeGeneratedName(raw): string | null`.
- `ConversationNamingDeps` (method syntax): `getTaskRunner`, `readConfig`, `mutateConversation`, `publish: PublishFn` — lazy production defaults, injectable for tests.
- `generateAndApplyConversationName(input: { projectPath; projectName; sessionName; conversationId; content; trigger: "auto" | "explicit" }, deps?)`:
  1. Single-flight map keyed by conversationId (concurrent call returns the in-flight promise; `finally` deletes).
  2. `resolveConversationNamingConfig`; `trigger === "auto" && !enabled` ⇒ skip.
  3. Read the configured backend and complete atomic `modelSelection`.
  4. `runner.run({ workingDirectory: projectPath, prompt, modelSelection, timeoutMs: config.timeoutMs ?? 60_000, executionProfile: "isolated-one-shot", autonomous: true, outputSchema })`.
  5. Extract structured `name`, fall back to first text line, sanitize.
  6. Apply via `mutateConversation(label: "applyGeneratedConversationName")` — auto: only while `nameOrigin === "default"` (skip + log `apply_skipped_origin` otherwise); explicit: unconditional. Sets `name` + `nameOrigin = "auto"`. Works for the `__project__` sentinel (same routing the persistence adapter relies on).
  7. On apply: `publishEventBestEffort` with `conversationRenamedEventSchema` + `conversationEventScopeFields(...)` (project scope handled by the helper).
  8. `createLogger("conversation-naming")`; events `conversation_naming.generation_started/.generation_completed/.generation_failed/.apply_skipped_origin`; never log prompt/content bodies.

**`src/lib/conversations/naming-context.ts`** (new — composes lib modules directly; no import from `tickets/`):

- `resolveConversationNamingContent({ conversationId, transcriptPath })`: artifact via `getContextArtifactsRepo().findByConversation` (complete + `coveredEndSeq >= maxSeq`) ⇒ `compactionEnvelopeToMarkdown`, else `readTranscriptEntriesWithSeq` → `renderCompactTranscript` (`includeTools: "summary"`, `maxBytes: 24_576`) → `renderedTranscriptToMarkdown`. Null when no transcript.
- `resolveMessageNamingContent({ transcriptPath, messageIndex })`: `messageRange N:N`, `includeTools: "none"`, `maxBytes: 16_384`. Null when transcript missing or index out of bounds.

**Tests** (fake `AgentTaskRunner` via DI; `createPersistenceFixture()` for the apply path; captured `publish`): success applies + publishes; auto skips when origin flipped mid-flight (mutate to `manual` between run and apply); explicit overwrites `manual`; sanitization table; structured→text fallback; failure/timeout leaves name untouched + no publish; single-flight coalescing; `enabled: false` blocks auto not explicit; incompatible model self-heals. Context tests: temp transcript files + fake artifact rows for fresh/stale/absent + budget truncation.

## Slice 4 — auto-trigger at first user turn

1. `src/lib/workflows/conversation/machine.ts` — stub action `triggerAutoNaming` in the defaults (:225-234) + append to `acquiringResources` entry after `markReadOnUserTurnStart` (:551-560).
2. `src/lib/workflows/conversation/manager.ts` — `.provide` wiring beside `markReadOnUserTurnStart` (:361-363): `triggerAutoNaming: ({ context }) => adapter.triggerAutoNaming(context)`.
3. `src/lib/workflows/conversation/persistence-adapter.ts` — interface method `triggerAutoNaming(context): void`; new dep `queueAutoName(input): void` on `ConversationPersistenceAdapterDeps` (lazy default = fire-and-forget `void generateAndApplyConversationName({... , trigger: "auto"}).catch(warn)`; overridable via `setConversationPersistenceAdapterDeps`). Durable impl applies the guard set (see decisions table) and passes `content: activeTurn.promptText.slice(0, 4_000)`. Ephemeral adapter: inert.

**Tests**: adapter tests — happy path calls `queueAutoName` exactly once with truncated content; one test per guard (`promptCount > 0`, `autonomous: true`, `task_run`, `role !== null`, `forkedFrom` set, empty text); ephemeral no-op. Machine default stub is a no-op, so existing machine tests are unaffected.

## Slice 5 — explicit regenerate API

1. `src/lib/conversations/schemas.ts` — `generateConversationNameRequestSchema = z.discriminatedUnion("source", [{ source: "conversation" }, { source: "message", messageIndex: z.number().int().min(0) }])` + `generateConversationNameResponseSchema = z.object({ name: z.string() })`.
2. `src/lib/conversations/lifecycle-route-handlers.ts` — `POST_GENERATE_NAME` mirroring `PATCH_RENAME` (:183-229): same resolution/404 ladder, parse body, load conversation (transcriptPath), resolve content via `naming-context`, call service with `trigger: "explicit"`, respond `200 { name }` / `400` invalid body / `404` ladder / `422` no resolvable content or index OOB / `500` generation failure. Export via `withTracing` (:362 pattern); extend the handler deps interface (DI for tests).
3. `src/lib/project-conversations/route-handlers.ts` — project twin mirroring the rename handler (:342-385, export :536 area).
4. New route files re-exporting POST: `src/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/generate-name/route.ts` and `src/app/api/projects/[name]/conversations/[conversationId]/generate-name/route.ts`.

**Tests**: handler tests with injected deps for both scopes — 200 happy path (returns generated name, service called with explicit trigger), 404 unknown conversation, 400 malformed body, 422 message OOB, 500 propagates failure reason.

## Slice 6 — client UI

1. `src/lib/conversations/mutations.ts` — `useGenerateConversationNameMutation()`: plain (non-optimistic) mutation; variables = generic rename union minus `name`, plus `messageIndex?: number`; extend `genericConversationMutationPath(vars, "generate-name")`; POST body from `messageIndex` presence; `onSuccess` patches session/project list + active caches with the returned name (reuse `renamedInActive` + `genericConversationUpdates`) — SSE remains the durable path; `onError` → `pushToast("Couldn't generate a conversation name")`.
2. `src/components/session/sidebar/conversation-row-menu.tsx` — `onRegenerateName?: () => void` in handlers; item `{ kind: "item", label: "Regenerate Name", onSelect }` right after `Rename…` (:157-161), hidden when handler absent.
3. `src/components/session/sidebar/ConversationSidebar.tsx` — instantiate the mutation (:364-370 area); wire in `buildRowItems` via `actionScope` (session vs project variables); add to the dep array (:779-793).
4. `src/features/session/tabs/ConversationTabStrip.tsx` — same wiring in `buildTabMenuItems` (:107-186) + deps (:175-185).
5. `src/components/GenerateNameFromMessageButton.tsx` (new) — props `{ target: ContextArtifactTarget; messageIndex: number }`; internal mutation with `messageIndex`; `msgActionBtnClass` + `WithTooltip` ("Name conversation from this message" / "Generating name…"); disabled + spinner while pending (Fork pattern); hand-authored 12×12 icon (viewBox/stroke conventions of `ForkIcon`/`CompactIcon`).
6. `src/components/MessageActions.tsx` — render the button inside `ActionBar` beside `CopyMessageRefButton` (:203-210) whenever `compactionTarget` is present (both roles; project cockpit naturally excluded — it passes no target).

**Tests/stories**: `conversation-row-menu.test.ts` (presence/absence/order), `mutations.test.ts` new describe (path, body shapes, cache patch on success, toast on error), `MessageActions.test.tsx` new suite (renders with target, absent without, POST fired with messageIndex, pending state), story additions in `MessageActions.stories.tsx`.

## Slice 7 — verification

1. `bun run typecheck && bun run lint && bun run seams:check && bun run test` (lint includes the seam ratchet; publication goes through `publishEventBestEffort` — no raw broadcaster).
2. Live pass (cc-live-feature-test): `cctl dev ensure` → fixture session → first prompt → assert `conversation-renamed` lands and SQLite row shows `name_origin = 'auto'`; manual rename → regenerate → per-message; `enabled: false` → no auto-name.

## Risks & accepted edge cases

- Double-submit before first finalize both see `promptCount === 0` → contained by single-flight + write-time origin guard.
- `/collab` and slash-command first messages bypass the seam → no auto-name (accepted; poor basis anyway).
- Existing DB rows get `name_origin = 'default'`, including historically manually-renamed ones — harmless: auto-naming only ever fires on a first turn.
- Machine gains one stub action — additive; `.provide` overrides in tests unaffected.

## Out of scope

Per-repo config override, backfill, cctl/CLI surface, fork naming, success toasts, project-cockpit per-message button, pending shimmer on rows.
