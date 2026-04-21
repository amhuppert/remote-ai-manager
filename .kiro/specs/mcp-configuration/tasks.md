# Implementation Plan

This plan delivers the MCP Configuration feature end to end: cascading global/project/session/conversation overrides, per-tool filtering, mid-conversation reconfiguration, and live UI across four surfaces — for both Claude and Codex, behind a backend-neutral abstraction.

Presentational UI components (`src/components/mcp/*`) and CSS are already in place; this plan wires data, runtime emission, and live updates behind them.

All implementation follows **red-green TDD**: write the failing test first, run it to confirm the red state, implement the minimum to pass, then re-run the focused test before broader checks.

---

## 1. Schema and domain type foundation

- [x] 1.1 Add MCP override shapes to persistent state schemas
  - Introduce a canonical override shape that carries per-server enabled flags and per-tool enabled flags as explicit diffs.
  - Attach optional override records to project, session, and conversation state schemas.
  - Introduce a standalone global override schema with a version and updated-at marker for the CC-level file.
  - Keep all additions additive so existing state records remain valid without migration.
  - Preserve single-source-of-truth schema conventions: Zod-first, types re-exported from the project's central type barrel.
  - _Requirements: 1.1, 1.2, 1.5, 8.1, 8.4_

- [x] 1.2 Add runtime application state schema for conversations
  - Extend conversation state with fields that track the last applied effective config hash, pending config hash, pending server keys, last apply disposition, and last apply error.
  - Ensure the shape supports the apply/defer decision flow and the mid-conversation pending indicator.
  - _Requirements: 6.1, 6.3, 6.4, 6.7_

- [x] 1.3 (P) Add API view model and patch request schemas
  - Add the scoped config view response shape with server rows, tool rows, inheritance status, source scope, orphan/reserved/pending flags, compatibility, and diagnostics.
  - Add the patch request shape carrying toggle-server, reset-server, toggle-tool, and reset-tool operations.
  - Add the tool inventory result shape carrying discovery state, tool list, diagnostics, and last refreshed timestamp.
  - _Requirements: 1.4, 2.5, 3.2, 3.4, 4.1, 4.8, 5.5, 5.6, 7.3, 7.4, 8.1, 8.4_

---

## 2. Native MCP source discovery

- [x] 2.1 Parse Claude MCP sources into canonical server definitions
  - Read project-scope `.mcp.json`, project-scope Claude settings, local Claude settings, and user Claude settings.
  - Emit one canonical definition per server tagged with its scope (user / project / local) and originating file path.
  - Surface malformed or unreadable files as per-file diagnostics without discarding other valid sources.
  - Redact environment values, headers, and bearer tokens in every view-facing field.
  - _Requirements: 7.1, 7.2, 7.4, 7.6_

- [x] 2.2 (P) Parse Codex MCP sources from TOML into canonical definitions
  - Read project-scope and user-scope Codex config TOML, extracting `mcp_servers` entries.
  - Preserve native Codex fields relevant to emission (enabled, enabled_tools, disabled_tools, env, startup/tool timeouts, bearer token env vars).
  - Emit canonical definitions tagged with scope and source file, applying the same redaction policy as Claude.
  - _Requirements: 7.1, 7.2, 7.4, 7.6_

- [x] 2.3 Compose unified discovery across backends with orphan-safe coalescing
  - Provide a single entry point that returns the combined definitions, source file status records, and diagnostics for the current worktree plus the current user config paths.
  - Coalesce Claude and Codex definitions into a single row only when their non-secret canonical config is equivalent; otherwise keep them distinct.
  - Never write to any discovered source file at any point in the discovery pipeline.
  - Log discovery with structured events (`mcp.source-discovery`) noting counts and scopes, never config contents.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 8.1, 8.5_

---

## 3. Override store

- [x] 3.1 Global override store backed by a new CC-level JSON file
  - Store global overrides atomically in the CC config directory (OS-aware path), following the existing write-temp-then-rename convention.
  - Read/write global overrides through a single abstraction that returns empty state when the file does not yet exist.
  - Remove empty override records after reset operations so the file stays small.
  - _Requirements: 1.1, 1.5, 1.6_

- [x] 3.2 (P) Per-scope override mutators for project, session, and conversation
  - Extend state mutation helpers so each level can read and write only its own override diff, never a full copy of the resolved config.
  - Guarantee atomic writes and single-scope serialization through the existing state mutation boundary.
  - Produce a list of changed server keys per patch so downstream services (apply, SSE) can narrow their effects.
  - _Requirements: 1.1, 1.5, 1.6, 3.1, 3.2, 6.1, 8.4_

---

## 4. Cascade resolver

- [x] 4.1 Implement patch-model cascade across all four levels
  - Walk the override chain top-down (global → project → session → conversation) and apply field-level patches rather than full replacement.
  - Remove an override at any level and fall through to the nearest ancestor providing a value.
  - Return the effective enabled state and effective tool filter set per server without branching on backend identity inside the resolver core.
  - _Requirements: 1.1, 1.2, 1.5, 8.1, 8.2_

- [x] 4.2 Orphan detection for servers and tools
  - Mark a server override as orphaned when no discovered definition matches its `serverKey` at resolve time and omit it from the emitted runtime config.
  - Mark a tool override as orphaned only when the server's tool discovery state is ready or stale and the named tool is not in the discovered inventory.
  - Keep disabled and orphaned rows visible in the view model even though they are excluded from the emitted runtime config.
  - _Requirements: 4.8, 7.5_

- [x] 4.3 View-model assembly with inheritance status, scope grouping, and compatibility
  - Tag each row with `explicit`, `inherited`, `overridden`, or `disabled` relative to the current view level.
  - Indicate the level at which an override originates so the UI can label the source.
  - Group rows by source scope (project / local / user) for UI consumption and mark CC-injected gateway servers as reserved and non-togglable when they appear.
  - Carry per-server backend compatibility from the capability registry without branching on backend in the UI.
  - _Requirements: 1.4, 2.3, 2.5, 3.3, 7.3, 7.4, 9.2, 10.7_

---

## 5. Tool discovery and cache

- [x] 5.1 Probe tools through a direct MCP SDK client for each supported transport
  - Implement tool listing for stdio, streamable HTTP, and SSE transports using the MCP SDK.
  - Apply strict startup and tool-call timeouts and always tear down spawned processes/streams on completion or failure.
  - Surface per-server errors as sanitized diagnostics; never leak stderr or raw exception messages.
  - _Requirements: 4.1, 5.1, 5.5_

- [x] 5.2 (P) Discover tools via the active Claude runtime when available
  - When a Claude conversation runtime exists for the requested scope, prefer its reported MCP server status as the source of truth for that conversation's tool inventory.
  - Fall back to the direct probe path when the runtime is not active or does not expose the needed server.
  - _Requirements: 4.1, 5.1_

- [x] 5.3 Tool inventory cache keyed by backend, serverKey, and config signature
  - Return cached tools when the signature is unchanged and expose a per-server state of not-loaded, loading, ready, stale, or error.
  - Invalidate the cache entry when the server's command, URL, transport, env, headers, or auth config changes.
  - Provide an explicit refresh entry point that forces re-discovery for a single server without affecting others.
  - Invalidate scoped view queries whenever discovery completes so orphan flags can appear in affected levels.
  - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6_

---

## 6. Backend capability registry

- [x] 6. Declare per-backend MCP capabilities through a single registry
  - Publish typed capability metadata for Claude and Codex describing: strict-authoritative config support, server-disable mechanism, between-turn apply mode, tool filtering mode (native vs permission-layer fallback), and tool discovery mode.
  - Route UI compatibility badges and runtime emission decisions through the same registry so no branching on backend identity is required outside the emission boundary.
  - Expose the registry shape so adding a new backend requires only a new entry plus a translator.
  - _Requirements: 4.6, 4.7, 6.5, 6.6, 8.2, 8.5, 10.7_

---

## 7. Runtime composer and gateway protection

- [x] 7.1 Compose the emitted runtime MCP list from the resolver output
  - Start with resolver-approved user-configured servers for the active backend and their effective tool filters.
  - Exclude orphaned server overrides from the emitted set while keeping them visible in the view model.
  - Preserve disabled servers for Codex emission as `enabled: false` so Codex does not fall back to its native TOML.
  - _Requirements: 2.2, 2.3, 4.3, 7.5_

- [x] 7.2 Append and protect CC-injected gateway servers
  - Always append the existing CC-injected gateway server definitions to the emitted set after user-configured servers.
  - Preserve gateway identifiers on collision with any user-defined server of the same name.
  - Mark gateway entries as reserved in the view model so no UI surface can expose a toggle for them.
  - _Requirements: 9.1, 9.2, 9.3_

---

## 8. Claude backend emission

- [x] 8.1 Extend the Claude translator for enabled, enabledTools, and disabledTools
  - Accept (rather than reject) `enabled`, `enabledTools`, and `disabledTools` on the canonical portable server entries.
  - Drop servers with `enabled: false` from the emitted Claude SDK config.
  - Route tool allow/deny lists to the fallback filter when the transport is stdio, and to any native policy field when exposed by the SDK for HTTP/SSE transports.
  - _Requirements: 4.3, 4.5, 4.6, 8.3_

- [x] 8.2 Enable `strictMcpConfig` and make CC the authoritative MCP source
  - Pass `strictMcpConfig: true` through the Claude query session so the SDK does not double-load MCP servers from filesystem sources.
  - Route the composed, gateway-appended server list through the existing `mcpServers` SDK option so CC's list is the entire effective configuration.
  - Keep `settingSources` behavior unchanged for non-MCP config (CLAUDE.md, skills, hooks, permissions).
  - _Requirements: 2.2, 2.3, 4.3, 4.5, 8.3_

- [x] 8.3 Implement the `canUseTool` MCP tool filter fallback
  - Run the MCP filter check first inside `canUseTool`, before any existing CC tool handler.
  - Consult the resolver through an injected filter-lookup dep so the handler stays test-friendly and does not import resolver state directly.
  - On denial, return the SDK's deny disposition with `interrupt: false` and a sanitized message; the turn must continue and the agent must receive the denial as a normal tool result.
  - Log denials through structured logging with serverKey, toolName, and scope; never log tool input payloads.
  - _Requirements: 4.4, 4.6, 4.7_

- [x] 8.4 Apply live MCP updates mid-conversation when the turn is idle
  - On idle Claude runtimes, call the existing live MCP replace path to install the newly resolved list without restarting the runtime.
  - While a turn is running, do not interrupt or abort it; defer apply to turn start.
  - Return the apply disposition so the apply service can record applied vs pending state correctly.
  - _Requirements: 6.2, 6.3, 6.5_

---

## 9. Codex backend emission

- [x] 9.1 Extend the Codex translator to emit enabled, enabled_tools, and disabled_tools
  - Emit `enabled: false` for disabled servers so Codex does not fall back to the TOML entry.
  - Pass through per-server `enabled_tools` and `disabled_tools` natively.
  - Preserve existing env, headers, bearer token env var, and timeout handling.
  - _Requirements: 2.3, 4.3, 4.5, 8.3_

- [x] 9.2 Stage resolved portable MCP at the start of the next Codex turn
  - Route resolver output into the existing per-turn instance reconstruction so the next turn starts with the latest effective config.
  - Ensure the "no live replace" case is transparent to the rest of the system through the runtime apply service.
  - _Requirements: 6.3, 6.6_

---

## 10. Runtime apply service

- [x] 10.1 Compute the effective config hash deterministically
  - Hash the user-resolved MCP definitions plus the protected gateway servers so the hash covers the full emitted set.
  - Compute the hash inside the state mutator's critical section, after persistence of the override patch but before the SSE broadcast.
  - Use the hash only for change detection; never expose it in the UI.
  - _Requirements: 6.3, 6.4, 6.7, 8.1_

- [x] 10.2 Decide apply-now vs defer-to-next-turn and update conversation runtime state
  - If no active runtime exists, record pending state only and rely on the next turn creation path.
  - If the Claude runtime is idle, apply now and record the applied hash.
  - If a turn is currently running, record pending state and pending server keys without interrupting.
  - For Codex, always stage for next-turn reconstruction regardless of idle state.
  - Clear the pending indicator at next-turn apply only when the hash that was successfully applied equals the current pending hash.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 10.3 Failure handling preserves `lastAppliedConfigHash`
  - On apply failure, keep the previous applied hash and store a sanitized error message.
  - Surface the failure as a diagnostic the UI can render without revealing secrets.
  - Ensure only the turn-start apply path mutates `lastAppliedConfigHash`; after-override-change apply only writes pending state.
  - _Requirements: 6.7_

---

## 11. Workflow actor integration

- [x] 11. Route the conversation workflow's MCP merge through the resolver
  - Replace the existing direct portable-MCP merge inside the conversation actor implementations with a call into the cascade resolver, honoring all four override levels plus gateway protection and orphan omission.
  - Preserve the existing seam for caller-supplied transient tooling overrides used by one-shot task runners.
  - _Requirements: 1.1, 1.2, 6.3, 8.2, 9.1_

---

## 12. API route handlers

- [x] 12.1 Global config endpoints for GET and PATCH
  - Return the resolved view for global scope with discovered user-scope servers and diagnostics.
  - Apply global override operations atomically and return the updated view.
  - Reject patches with a 409 when the client's expected effective config hash does not match the hash computed immediately before the write.
  - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.4, 3.1, 3.2, 4.2, 4.3, 7.3, 7.4_

- [x] 12.2 (P) Project config endpoints for GET and PATCH
  - Return the resolved view for project scope with the global cascade applied and diagnostics.
  - Apply project override operations atomically and trigger invalidation of downstream session and conversation views in the same project.
  - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.4, 3.1, 3.2, 4.2, 4.3, 10.2_

- [x] 12.3 (P) Session config endpoints for GET and PATCH
  - Return the resolved view for session scope with the global and project cascades applied.
  - Apply session override operations atomically and trigger re-emission on active runtimes of all conversations within that session.
  - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.4, 3.1, 3.2, 4.2, 4.3, 10.3, 10.4_

- [x] 12.4 (P) Conversation config endpoints for GET and PATCH
  - Return the resolved view for conversation scope with the full cascade applied and live tool lists for discovered servers.
  - Apply conversation override operations atomically, record the apply disposition, and return the new view plus apply result.
  - _Requirements: 1.1, 1.5, 1.6, 2.1, 2.4, 3.1, 3.2, 4.2, 4.3, 6.1, 6.2, 6.3, 6.4, 6.7, 10.5_

- [x] 12.5 Tool inventory endpoints for GET and force-refresh POST
  - Serve cached tool inventories for a given server within the requested scope without blocking other servers.
  - Force re-discovery on POST for a single server and update the cache entry only after completion.
  - Use a route path that does not collide with the existing streamable HTTP MCP gateway route.
  - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6_

---

## 13. Live-update SSE events

- [x] 13.1 Broadcast `mcp-config-updated` after each scope mutation
  - Emit one event per successful patch, scoped to the affected level and scope identifiers.
  - Include only identifiers, changed server keys, and the new effective config hash (no server/tool configuration contents).
  - _Requirements: 11.1, 11.2, 11.3_

- [x] 13.2 Broadcast `mcp-tools-updated` after tool inventory refreshes
  - Emit one event per completed tool refresh scoped to the server and scope identifiers.
  - _Requirements: 5.4, 11.1, 11.2_

---

## 14. Query and mutation layer

- [x] 14.1 Scoped query factories for all four MCP levels
  - Provide query keys by scope and backend and fetch the scoped config view response from the matching endpoint.
  - Invalidate narrowly on matching SSE events and invalidate all MCP query keys on SSE reconnect.
  - Provide a separate query path for per-server tool inventories keyed by server.
  - _Requirements: 5.5, 5.6, 11.1, 11.2, 11.3_

- [x] 14.2 Mutation factories with auto-promote, optimistic UI, and rollback
  - Implement toggle-server, reset-server, toggle-tool, reset-tool, and refresh-tools mutations parameterized by view level.
  - When the toggle is invoked on an inherited row, auto-promote to an explicit override at the current view level with the flipped value; expose an explicit override affordance that promotes without changing value.
  - Apply optimistic disabled/pending UI and roll back on failure; invalidate related caches on success.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.4_

---

## 15. UI surface wiring

- [x] 15.1 (P) Wire the conversation-level MCP popover into the prompt toolbar
  - Mount the existing `McpConfigButton` / `McpConfigPopover` next to the backend, model, and related controls on the session detail page.
  - Subscribe to the conversation-scope query and drive actions through the conversation-level mutations with auto-promote semantics.
  - Surface the "pending — applies on next turn" indicator while the turn is running based on conversation runtime state.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 6.2, 6.4, 10.5, 10.6, 10.7_

- [x] 15.2 (P) Wire the session-level chip, info-details row, and modal
  - Add the session `McpInfoChip` to the session overview info strip.
  - Add an MCP servers row inside the details popover that opens the session-level modal.
  - Mount the shared MCP servers modal wired to session-scope query and mutations.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 10.3, 10.4, 10.6, 10.7_

- [x] 15.3 (P) Wire the project-level MCP modal
  - Add an MCP button on the project actions bar that opens the shared modal.
  - Mount the modal wired to project-scope query and mutations.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 10.2, 10.6, 10.7_

- [x] 15.4 (P) Wire the global-level MCP configuration section
  - Insert the existing global section into the config editor between the Codex and Workflow Defaults sections.
  - Surface source-scope grouping, reserved gateway visibility rules, and inheritance labels appropriate to the global view.
  - _Requirements: 7.3, 7.4, 9.1, 9.2, 10.1, 10.6, 10.7_

---

## 16. End-to-end verification

- [x] 16.1 Mid-conversation Claude verification
  - With a running Claude conversation, toggle a server and a tool at the conversation level; confirm the live replace path applies when idle and that a turn-in-progress change appears as pending until the next turn starts.
  - Confirm disabled stdio tools are blocked via the `canUseTool` fallback and return a non-fatal denial.
  - Confirm `strictMcpConfig` makes CC's list authoritative (no filesystem duplicates).
  - _Requirements: 2.2, 4.3, 4.4, 4.7, 6.2, 6.3, 6.4, 6.5_

- [x] 16.2 Mid-conversation Codex verification
  - With an active Codex conversation, toggle a server and a tool; confirm the next turn is constructed with the new effective config.
  - Confirm a disabled server is not spawned (Codex respects `enabled: false`) and native tool filters are honored.
  - _Requirements: 2.2, 4.3, 4.4, 6.3, 6.6_

- [x] 16.3 Cross-client live update verification
  - Open two clients on the same conversation; patch at the session level from one; confirm the other invalidates and re-renders from the SSE event.
  - Disconnect/reconnect one client; confirm full MCP query invalidation on reconnect.
  - _Requirements: 11.1, 11.2, 11.3_

- [x] 16.4 Static checks and test suite green
  - Run the full typecheck and test suite; resolve any failures that landed during wiring.
  - Visually verify all four UI surfaces through Storybook plus a local dev server session.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

---

## Requirements Coverage Matrix

Every requirement ID in `requirements.md` maps to at least one task above:

| Requirement | Tasks |
|-------------|-------|
| 1.1 | 1.1, 3.1, 3.2, 4.1, 11, 12.1, 12.2, 12.3, 12.4 |
| 1.2 | 1.1, 4.1, 11 |
| 1.3 | 1.1, 3.1, 3.2 |
| 1.4 | 1.3, 4.3 |
| 1.5 | 1.1, 3.1, 3.2, 4.1, 12.1, 12.2, 12.3, 12.4 |
| 1.6 | 3.1, 3.2, 12.1, 12.2, 12.3, 12.4 |
| 2.1 | 12.1, 12.2, 12.3, 12.4 |
| 2.2 | 7.1, 8.2, 16.1, 16.2 |
| 2.3 | 4.3, 7.1, 8.1, 8.2, 9.1 |
| 2.4 | 12.1, 12.2, 12.3, 12.4 |
| 2.5 | 1.3, 4.3 |
| 3.1 | 12.1, 12.2, 12.3, 12.4, 14.2, 15.1, 15.2, 15.3 |
| 3.2 | 1.3, 12.1, 12.2, 12.3, 12.4, 14.2, 15.1, 15.2, 15.3 |
| 3.3 | 4.3, 14.2, 15.1, 15.2, 15.3 |
| 3.4 | 1.3, 14.2, 15.1, 15.2, 15.3 |
| 4.1 | 1.3, 5.1, 5.2 |
| 4.2 | 12.1, 12.2, 12.3, 12.4 |
| 4.3 | 4.3, 7.1, 8.1, 8.2, 9.1, 16.1, 16.2 |
| 4.4 | 8.3, 16.1, 16.2 |
| 4.5 | 8.1, 9.1 |
| 4.6 | 6, 8.1, 8.3 |
| 4.7 | 6, 8.3, 16.1 |
| 4.8 | 1.3, 4.2 |
| 5.1 | 5.1, 5.2, 12.5 |
| 5.2 | 5.3 |
| 5.3 | 5.3 |
| 5.4 | 5.3, 12.5, 13.2, 14.2 |
| 5.5 | 1.3, 5.1, 5.3, 12.5, 14.1 |
| 5.6 | 1.3, 5.3, 12.5, 14.1 |
| 6.1 | 1.2, 3.2, 10.2, 12.4 |
| 6.2 | 1.2, 8.4, 10.2, 12.4, 15.1, 16.1 |
| 6.3 | 1.2, 9.2, 10.1, 10.2, 11, 12.4, 16.1, 16.2 |
| 6.4 | 1.2, 10.1, 10.2, 12.4, 15.1, 16.1 |
| 6.5 | 6, 8.4, 10.2, 16.1 |
| 6.6 | 6, 9.2, 10.2, 16.2 |
| 6.7 | 1.2, 10.1, 10.2, 10.3, 12.4 |
| 7.1 | 2.1, 2.2, 2.3 |
| 7.2 | 2.1, 2.2, 2.3 |
| 7.3 | 1.3, 2.3, 4.3, 12.1, 15.4 |
| 7.4 | 1.3, 2.1, 2.2, 2.3, 4.3, 12.1, 15.4 |
| 7.5 | 4.2, 7.1 |
| 7.6 | 2.1, 2.2, 2.3 |
| 8.1 | 1.1, 1.3, 4.1, 10.1 |
| 8.2 | 4.1, 11 |
| 8.3 | 8.1, 8.2, 9.1 |
| 8.4 | 1.1, 1.3 |
| 8.5 | 2.3, 6 |
| 9.1 | 7.2, 11, 15.4 |
| 9.2 | 4.3, 7.2, 15.4 |
| 9.3 | 7.2 |
| 10.1 | 15.4, 16.4 |
| 10.2 | 12.2, 15.3, 16.4 |
| 10.3 | 12.3, 15.2, 16.4 |
| 10.4 | 12.3, 15.2, 16.4 |
| 10.5 | 12.4, 15.1, 16.4 |
| 10.6 | 15.1, 15.2, 15.3, 15.4, 16.4 |
| 10.7 | 4.3, 6, 15.1, 15.2, 15.3, 15.4, 16.4 |
| 11.1 | 13.1, 13.2, 14.1, 16.3 |
| 11.2 | 13.1, 13.2, 14.1, 16.3 |
| 11.3 | 13.1, 14.1, 16.3 |

No requirements are deferred.
