# Requirements Document

## Introduction
The Reference Documents feature adds a general file-based mechanism for inter-agent communication across conversations within Command Center. Agents register files as reference documents in a session using MCP tools. Registered documents are listed in the system prompt when starting new conversations, enabling agents to discover and read context left by previous conversations. The UI replaces the existing Focus tab with a generalized Docs tab for browsing and viewing registered documents. The conventional directory for agent-written reference documents is `.cc/references/` within the session worktree, with `focus.md` as a special case that stays at `memory-bank/focus.md` and is auto-registered.

## Requirements

### Requirement 1: Reference Document Schema
**Objective:** As a developer, I want a well-defined data model for reference documents, so that document metadata is consistently structured and validated.

#### Acceptance Criteria
1. The system shall define a `referenceDocumentSchema` in `schemas.ts` with fields: `id` (string), `filePath` (string), `description` (string), and `createdAt` (string, ISO 8601 timestamp).
2. The system shall add a `referenceDocuments` array field to `sessionStateSchema`, defaulting to an empty array `[]`.
3. The system shall derive a `ReferenceDocument` TypeScript type from the Zod schema via `z.infer`.

### Requirement 2: State Mutation Operations
**Objective:** As a developer, I want state mutation functions for managing reference documents, so that MCP tools and API routes can create, read, and delete documents through a consistent interface.

#### Acceptance Criteria
1. When `createReferenceDocument` is called with a `projectPath`, `sessionName`, `filePath`, and `description`, the system shall create a new reference document entry in `SessionState.referenceDocuments` with a generated `id` and `createdAt` timestamp, using `mutateSession()` for atomic writes.
2. When `createReferenceDocument` is called with a `filePath` that already exists in the session's `referenceDocuments`, the system shall update the existing document's `description` rather than creating a duplicate entry.
3. When `deleteReferenceDocument` is called with a `projectPath`, `sessionName`, and `documentId`, the system shall remove the matching document entry from `SessionState.referenceDocuments`.
4. When `getReferenceDocuments` is called with a `projectPath` and `sessionName`, the system shall return the array of all reference documents for that session.

### Requirement 3: MCP Tool Server — register_document
**Objective:** As an agent, I want to register a file as a reference document for the session, so that other conversations can discover and read it.

#### Acceptance Criteria
1. The system shall expose a `register_document` MCP tool accepting `file_path` (string) and `description` (string) inputs.
2. When `register_document` is called, the system shall store the document metadata in `SessionState.referenceDocuments` via the state mutation layer.
3. When `register_document` is called with a `file_path` that is already registered, the system shall update the description of the existing entry (idempotent behavior).
4. When `register_document` succeeds, the system shall return a text response confirming registration with the document's file path.

### Requirement 4: MCP Tool Server — list_documents
**Objective:** As an agent, I want to list all registered reference documents in the session, so that I can discover what context is available.

#### Acceptance Criteria
1. The system shall expose a `list_documents` MCP tool with no required inputs.
2. When `list_documents` is called, the system shall return a formatted list of all registered reference documents including their `id`, `filePath`, and `description`.
3. When `list_documents` is called and no documents are registered, the system shall return a text response indicating no documents are registered.

### Requirement 5: MCP Tool Server — delete_document
**Objective:** As an agent, I want to delete a reference document from the session, so that outdated or irrelevant documents are removed.

#### Acceptance Criteria
1. The system shall expose a `delete_document` MCP tool accepting a `document_id` (string) input.
2. When `delete_document` is called, the system shall remove the document metadata from `SessionState.referenceDocuments` via the state mutation layer.
3. When `delete_document` is called, the system shall delete the file at the registered `filePath` from disk.
4. If `delete_document` is called with a `document_id` that does not exist, the system shall return an error response indicating the document was not found.
5. If the file at the registered `filePath` does not exist on disk when `delete_document` is called, the system shall still remove the metadata entry without error.

### Requirement 6: MCP Tool Server Architecture
**Objective:** As a developer, I want the MCP tool server to follow existing patterns, so that the codebase remains consistent and testable.

#### Acceptance Criteria
1. The system shall implement the three MCP tools in a single `reference-document-tools.ts` module following the DI pattern from `roadmap-tools.ts`.
2. The system shall define a `Context` interface carrying `projectPath`, `sessionName`, and `worktreePath`.
3. The system shall define a `Deps` interface with method syntax for dependency injection of state operations and file system operations.
4. The system shall export `defaultDeps` wired to real implementations.
5. The system shall return `McpSdkServerConfigWithInstance` from the tool server factory.

### Requirement 7: System Prompt Integration
**Objective:** As an agent starting a new conversation, I want to see a list of available reference documents in the system prompt, so that I know what context files exist and when to read them.

#### Acceptance Criteria
1. When starting a new conversation, the system shall build a section listing all registered reference documents and append it to `systemPromptParts` in `actor-implementations.ts`.
2. The reference documents section shall format each document as a bullet item containing the `filePath` and `description`.
3. While there are no registered reference documents for the session, the system shall omit the reference documents section from the system prompt entirely.

### Requirement 8: Auto-Registration of focus.md
**Objective:** As a session user, I want `focus.md` to be automatically registered as a reference document before each conversation, so that the session's current focus is always available to agents without manual registration.

#### Acceptance Criteria
1. When starting a new conversation, the system shall check if `memory-bank/focus.md` exists in the session worktree before prompt execution.
2. When `memory-bank/focus.md` exists and is not already registered, the system shall auto-register it as a reference document with the description "Current work-in-progress and remaining tasks for this session".
3. When `memory-bank/focus.md` exists and is already registered, the system shall not create a duplicate entry (relying on idempotent registration).
4. The system shall keep `focus.md` at its original path `memory-bank/focus.md` and shall not move it to `.cc/references/`.

### Requirement 9: API Route — List Reference Documents
**Objective:** As a UI client, I want an API endpoint to list registered reference documents for a session, so that the Docs tab can display them.

#### Acceptance Criteria
1. The system shall expose a `GET /api/projects/[name]/sessions/[session]/reference-documents` endpoint.
2. When the endpoint is called, the system shall return a JSON array of reference document objects from the session state.
3. The system shall use `withTracing()` for request tracing on the endpoint.

### Requirement 10: API Route — Read Document Content
**Objective:** As a UI client, I want an API endpoint to read the content of a specific reference document, so that the Docs tab can display document content inline.

#### Acceptance Criteria
1. The system shall expose a `GET /api/projects/[name]/sessions/[session]/reference-documents/[id]/content` endpoint.
2. When the endpoint is called with a valid document `id`, the system shall read the file at the document's registered `filePath` from disk and return the content as a text response.
3. If the document `id` does not exist in the session's reference documents, the system shall return a 404 response.
4. If the file at the registered `filePath` does not exist on disk, the system shall return a 404 response.

### Requirement 11: UI — Docs Tab Replaces Focus Tab
**Objective:** As a user, I want the Focus tab replaced with a generalized Docs tab, so that I can browse all registered reference documents — not just focus.md.

#### Acceptance Criteria
1. The system shall replace the "Focus" tab with a "Docs" tab in `RightPane`.
2. The system shall update the `RightPaneTab` type from `"diff" | "focus" | "specs"` to `"diff" | "docs" | "specs"`.
3. The system shall update the `MobilePanel` type similarly, replacing `"focus"` with `"docs"`.
4. When the Docs tab is active, the system shall display a list of all registered reference documents for the current session, showing file path and description.
5. When a user clicks on a Markdown or text document in the list, the system shall display the document content inline using `MarkdownViewer`.

### Requirement 12: UI — Query and State Integration
**Objective:** As a developer, I want proper React Query integration for reference documents, so that the UI stays consistent with the server state.

#### Acceptance Criteria
1. The system shall define a query key factory for reference documents in `query-keys.ts`.
2. The system shall define a `useReferenceDocumentsQuery` hook in `queries.ts` using the key factory and `apiClient`.
3. The system shall define a `useReferenceDocumentContentQuery` hook in `queries.ts` for fetching individual document content.

### Requirement 13: Cleanup of Old Focus-Doc Code
**Objective:** As a developer, I want all old focus-doc code removed, so that the codebase has no dead code or dual implementations.

#### Acceptance Criteria
1. The system shall remove the `focus-doc` API route at `src/app/api/projects/[name]/sessions/[session]/focus-doc/`.
2. The system shall remove `useFocusDocQuery` from `queries.ts`.
3. The system shall remove focus-doc related query keys from `query-keys.ts`.
4. The system shall remove all Focus tab references from UI components (tab buttons, panel content, CSS).

### Requirement 14: MCP Server Registration
**Objective:** As a developer, I want the reference document MCP server registered in the conversation query flow, so that agents can access the tools during conversations.

#### Acceptance Criteria
1. When creating a query session, the system shall register the reference document MCP server in the `mcpServers` object passed to `createQuerySession()`.
2. The system shall lazy-load the `reference-document-tools` module via dynamic `import()` in `ActorImplementationDeps`.
