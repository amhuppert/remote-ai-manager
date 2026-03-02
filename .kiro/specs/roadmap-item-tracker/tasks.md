# Implementation Plan

- [x] 1. Define the roadmap item data model and extend project state
  - Add Zod schemas for the roadmap item entity, item type enum (bug, feature, idea), and item status enum (incomplete, done)
  - Add request validation schemas for creating items (title required, description optional, type required) and updating items (at least one of status or archived required)
  - Extend the project state schema to include a roadmap items array, defaulting to empty
  - Export all derived types from the types module
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Implement state mutation functions for roadmap item CRUD
  - Add a create function that generates a UUID, sets timestamps, and appends the item to the project's roadmap items array
  - Add an update function that modifies status and/or archived flag and updates the timestamp, throwing if the item ID is not found
  - Add a delete function that permanently removes an item by ID, throwing if not found
  - Add a read function that returns all roadmap items for a given project
  - All write operations must use the existing mutex-protected state mutation pattern for atomic persistence
  - _Requirements: 2.1, 2.2, 2.4, 3.1, 3.3, 4.1, 4.2, 5.1, 5.2_

- [x] 3. Build API routes for roadmap item operations
- [x] 3.1 (P) Build the collection endpoint for listing and creating roadmap items
  - Handle GET to return all items for a project
  - Handle POST to create a new item, validating the request body and returning the created item with its generated ID
  - Return 404 if the project is not found
  - Wrap with request tracing for observability
  - _Requirements: 2.3, 2.4_

- [x] 3.2 (P) Build the single-item endpoint for updating and deleting roadmap items
  - Handle PATCH to update an item's status and/or archived flag, validating that at least one field is provided
  - Handle DELETE to permanently remove an item by ID
  - Return 404 if the project or item is not found, 400 for validation errors
  - Wrap with request tracing for observability
  - _Requirements: 3.2, 3.3, 4.3, 5.5_

- [x] 3.3 (P) Build the focus session endpoint to transition a roadmap item into Focus mode
  - Compose the objective from the item's title and description
  - Create a Focus mode session using the existing session creation function
  - Mark the source item as done after successful session creation
  - Return the created session state so the client can navigate to it
  - Return 404 if the project or item is not found
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 4. Build the client data layer for roadmap items
- [x] 4.1 (P) Add React Query hooks and mutation factories for roadmap items
  - Define query keys for roadmap item lists scoped by project name
  - Add a query hook to fetch roadmap items with a polling interval
  - Add mutation hooks for creating, updating, deleting items, and starting a Focus session from an item
  - Each mutation should invalidate the roadmap items list on success; the Focus mutation should also invalidate the sessions list
  - _Requirements: 2.1, 3.1, 4.1, 5.1, 7.1_

- [x] 4.2 (P) Create the Zustand store for roadmap items UI state
  - Store the archive visibility toggle (show/hide archived items, default hidden)
  - Export selector and action hooks following the existing store patterns
  - _Requirements: 5.3, 5.4, 6.6_

- [x] 5. Build the roadmap items panel and integrate into the project page
- [x] 5.1 Build the panel component with item list, add form, and actions
  - Display items organized by type (bugs, features, ideas) with title, type indicator, and status
  - Include an inline add form with type selector pills, title input, and optional description
  - Support toggling item status directly from the list via a checkbox
  - Support archiving and deleting items, with a confirmation dialog for deletion
  - Filter out archived items by default; show them when the archive toggle is active, along with a count of archived items
  - Include a "Start Focus" action button on each item to transition it into a Focus mode session
  - Navigate to the newly created session after Focus transition
  - Follow the design system: mono font, semantic colors for types, icon-only action buttons
  - _Requirements: 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.3_

- [x] 5.2 Wire the roadmap items panel into the project page
  - Render the panel above the sessions table on the project page
  - Ensure the panel integrates visually with the existing page layout
  - _Requirements: 6.1_

## Requirements Coverage

| Requirement | Covered By |
|-------------|------------|
| 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 | Task 1 |
| 2.1, 2.2, 2.4 | Task 2 |
| 2.3 | Task 3.1 |
| 3.1, 3.3 | Task 2 |
| 3.2 | Task 3.2 |
| 4.1, 4.2 | Task 2 |
| 4.3 | Task 3.2 |
| 5.1, 5.2 | Task 2 |
| 5.3, 5.4 | Task 4.2, 5.1 |
| 5.5 | Task 3.2 |
| 6.1 | Task 5.1, 5.2 |
| 6.2, 6.3, 6.4, 6.5 | Task 5.1 |
| 6.6 | Task 4.2, 5.1 |
| 7.1 | Task 3.3, 4.1, 5.1 |
| 7.2, 7.4 | Task 3.3 |
| 7.3 | Task 5.1 |
