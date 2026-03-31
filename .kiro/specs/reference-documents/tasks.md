# Implementation Plan

- [x] 1. Add reference document schema and session state field
- [x] 1.1 Define the reference document Zod schema with id, filePath, description, and createdAt fields, and derive the TypeScript type via z.infer
  - Add the schema alongside existing entity schemas
  - Export the type from the types index
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 1.2 Add a referenceDocuments array field to the session state schema, defaulting to an empty array
  - Ensures backward compatibility with existing sessions that lack this field
  - _Requirements: 1.1, 1.2_

- [x] 2. Implement state mutation functions for reference documents
- [x] 2.1 Implement createReferenceDocument that creates a new entry or updates the description when a document with the same file path already exists
  - Use mutateSession for atomic writes
  - Generate a UUID for new entries and set createdAt timestamp
  - Find existing entries by filePath and update description in place for idempotent behavior
  - Return the created or updated document
  - Write tests covering: new document creation, idempotent update of existing filePath, session not found error
  - _Requirements: 2.1, 2.2_

- [x] 2.2 (P) Implement deleteReferenceDocument that removes a document entry from state and returns the removed document for the caller to handle file deletion
  - Use mutateSession for atomic writes
  - Return the removed document (with filePath) or null if not found
  - Write tests covering: successful deletion, document not found returns null
  - _Requirements: 2.3_

- [x] 2.3 (P) Implement getReferenceDocuments that reads all reference documents for a given session
  - Read from state without mutation
  - Return empty array when no documents exist
  - Write tests covering: returns documents, returns empty array for session with no documents
  - _Requirements: 2.4_

- [x] 3. Build the MCP tool server for reference document management
- [x] 3.1 Create the tool server module following the existing MCP tool DI pattern with Context and Deps interfaces
  - Context carries projectPath, sessionName, and worktreePath
  - Deps interface uses method syntax for state operations (create, delete, list) and file deletion
  - Export defaultDeps wired to real implementations
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 3.2 Implement the register_document tool that accepts file_path and description, stores document metadata via state deps, and returns confirmation
  - Handle idempotent registration (existing filePath updates description)
  - Return success message with the document's file path
  - Wrap in try/catch and return error response on failure
  - Write tests with injected deps covering: successful registration, idempotent update, error handling
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3.3 (P) Implement the list_documents tool that returns a formatted list of all registered documents or a message when none exist
  - Format each document with id, filePath, and description
  - Return "no documents registered" message for empty list
  - Write tests covering: formatted list output, empty list response
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 3.4 (P) Implement the delete_document tool that removes the metadata entry and deletes the file from disk
  - Call state deps to remove the entry and get the filePath
  - Call file deletion dep to remove the file, tolerating file-not-found gracefully
  - Return error response when document_id is not found in state
  - Write tests covering: successful deletion with file removal, document not found error, file already deleted on disk
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 4. Integrate MCP server and system prompt into the conversation flow
- [x] 4.1 Register the reference document MCP server in the conversation actor implementations
  - Add the tool server factory to the deps interface and lazy-load the module
  - Register the server unconditionally in the mcpServers object with projectPath, sessionName, and worktreePath context
  - _Requirements: 14.1, 14.2_

- [x] 4.2 Add auto-registration of focus.md before each conversation starts
  - Check if memory-bank/focus.md exists in the session worktree
  - If it exists, register it as a reference document with a standard description via the state layer
  - Idempotent: re-registration updates the description without creating duplicates
  - Add the necessary state deps (createReferenceDocument) to the actor implementations deps interface
  - Write tests covering: focus.md exists and gets registered, focus.md does not exist and is skipped, already registered gets updated
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 4.3 Append registered reference documents to the system prompt
  - After auto-registration, read the session's reference documents
  - Build a section listing each document's file path and description as bullet items
  - Add the section to the systemPromptParts array; omit when no documents exist
  - Add getReferenceDocuments to the actor implementations deps interface
  - Write tests covering: documents appended to prompt, empty list produces no section
  - _Requirements: 7.1, 7.2, 7.3_

- [x] 5. Add API routes for the UI to list and read reference documents
- [x] 5.1 (P) Create a GET endpoint to list all registered reference documents for a session
  - Resolve the project path and session state
  - Return the referenceDocuments array as JSON
  - Use request tracing wrapper
  - Return 404 when project or session is not found
  - _Requirements: 9.1, 9.2, 9.3_

- [x] 5.2 (P) Create a GET endpoint to read the content of a specific reference document by its id
  - Find the document by id in the session's reference documents
  - Resolve the file path (join relative paths with the session worktree path)
  - Read the file from disk and return its content as JSON
  - Return 404 when the document id or the file is not found
  - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 6. Replace the Focus tab with a Docs tab in the UI
- [x] 6.1 Update the session detail store types from "focus" to "docs" for both the right pane tab and mobile panel type unions
  - Update the default tab value if it was "focus"
  - Update all references in the store's action implementations
  - _Requirements: 11.2, 11.3_

- [x] 6.2 Add query key factory and React Query hooks for fetching reference documents and document content
  - Define a referenceDocumentKeys factory in the query keys module
  - Implement useReferenceDocumentsQuery hook that fetches the document list from the list API
  - Implement useReferenceDocumentContentQuery hook that fetches content for a selected document, enabled only when a document id is provided
  - _Requirements: 12.1, 12.2, 12.3_

- [x] 6.3 Build the Docs tab panel component that displays a list of registered documents and shows document content inline when selected
  - Show document file name and description in the list
  - On click, fetch and display the document content using the existing Markdown viewer
  - Show an empty state message when no documents are registered
  - The Docs tab is unconditionally visible (not gated by creation mode)
  - _Requirements: 11.4, 11.5_

- [x] 6.4 Replace the Focus tab button and panel with the Docs tab in the right pane and mobile layout
  - Remove the conditional focus-mode gating on tab rendering
  - Wire the Docs panel into the right pane body using the show/hide display pattern
  - Update mobile panel tab buttons to use "docs" instead of "focus"
  - _Requirements: 11.1_

- [x] 7. Clean up all old focus-doc code
- [x] 7.1 Remove the focus-doc API route
  - _Requirements: 13.1_

- [x] 7.2 Remove useFocusDocQuery from the queries module and the focusDoc key from the query keys module
  - _Requirements: 13.2, 13.3_

- [x] 7.3 Remove all remaining Focus tab references from UI components, including tab buttons, panel content, conditional rendering, and any related CSS
  - Update the SessionDetailPage mobile panel handler and rendering logic
  - Verify no dead code remains referencing "focus" as a tab or panel value
  - _Requirements: 13.4_
