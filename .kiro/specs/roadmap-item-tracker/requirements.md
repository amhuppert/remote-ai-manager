# Requirements Document

## Introduction
The Roadmap Item Tracker adds a lightweight planning feature to Command Center, allowing users to track bugs, planned features, and ideas per project. Items have simple status tracking (incomplete/done), support archiving (following the existing `archived: boolean` pattern used by conversations, sessions, and projects), and can be seamlessly transitioned into Focus mode sessions where the item description becomes the objective for the initialization conversation.

## Requirements

### Requirement 1: Roadmap Item Data Model
**Objective:** As a developer, I want roadmap items stored per project with a consistent schema, so that items integrate naturally with CC's existing state management.

#### Acceptance Criteria
1. The Command Center shall store roadmap items as part of ProjectState in state.json.
2. The Command Center shall define each roadmap item with a unique ID, title, description, type, status, archived flag, and timestamps.
3. The Command Center shall support three item types: `bug`, `feature`, and `idea`.
4. The Command Center shall support two status values: `incomplete` and `done`.
5. The Command Center shall default new items to `status: "incomplete"` and `archived: false`.
6. The Command Center shall define the roadmap item schema using Zod in `src/lib/schemas.ts`, consistent with existing entity patterns.

### Requirement 2: Adding Roadmap Items
**Objective:** As a developer, I want to add roadmap items to a project, so that I can track work that needs to be done.

#### Acceptance Criteria
1. When the user submits a new roadmap item, the Command Center shall create the item with the provided title, description, and type.
2. When the user creates an item without specifying a description, the Command Center shall allow the item to be created with the title alone.
3. The Command Center shall provide an API endpoint for creating roadmap items under a project.
4. When an item is created, the Command Center shall assign a unique ID and set `createdAt` to the current timestamp.

### Requirement 3: Removing Roadmap Items
**Objective:** As a developer, I want to delete roadmap items, so that I can remove items that are no longer relevant.

#### Acceptance Criteria
1. When the user requests deletion of a roadmap item, the Command Center shall permanently remove the item from state.
2. The Command Center shall provide an API endpoint for deleting a roadmap item by ID.
3. If the specified item ID does not exist, the Command Center shall return an appropriate error response.

### Requirement 4: Status Tracking
**Objective:** As a developer, I want to toggle item status between incomplete and done, so that I can track progress on roadmap items.

#### Acceptance Criteria
1. When the user toggles an item's status, the Command Center shall update the status between `incomplete` and `done`.
2. When the status changes, the Command Center shall update the item's `updatedAt` timestamp.
3. The Command Center shall provide an API endpoint for updating a roadmap item's status.

### Requirement 5: Archiving Roadmap Items
**Objective:** As a developer, I want to archive roadmap items so they are hidden by default, following the same pattern used for conversations, sessions, and projects.

#### Acceptance Criteria
1. When the user archives a roadmap item, the Command Center shall set `archived: true` on the item.
2. When the user unarchives a roadmap item, the Command Center shall set `archived: false` on the item.
3. While displaying roadmap items, the Command Center shall filter out archived items by default.
4. When the user toggles "show archived", the Command Center shall display all items including archived ones.
5. The Command Center shall provide an API endpoint for setting the archived state of a roadmap item.

### Requirement 6: Roadmap Item List UI
**Objective:** As a developer, I want a UI to view and manage roadmap items for a project, so that I can interact with my project roadmap visually.

#### Acceptance Criteria
1. The Command Center shall display roadmap items on the project page, organized by type (bugs, features, ideas).
2. The Command Center shall show item title, type, and status in the list view.
3. The Command Center shall allow creating new items via an inline form or modal.
4. The Command Center shall allow toggling item status directly from the list.
5. The Command Center shall allow archiving and deleting items from the list.
6. The Command Center shall display a count of archived items when archived items exist.

### Requirement 7: Focus Mode Transition
**Objective:** As a developer, I want to transition a roadmap item into a Focus mode session, so that I can start working on an item with Claude in an objective-driven session.

#### Acceptance Criteria
1. The Command Center shall provide an action on each roadmap item to start a Focus session from it.
2. When the user initiates a Focus session from an item, the Command Center shall use the item's title and description as the objective for `createSessionFocus()`.
3. When a Focus session is created from an item, the Command Center shall navigate the user to the new session.
4. When a Focus session is created from an item, the Command Center shall mark the item status as `done`.
