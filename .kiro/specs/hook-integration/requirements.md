# Requirements Document

> **DEPRECATED (2026-02-22):** This entire feature was removed during the migration to `@anthropic-ai/claude-agent-sdk`. CSM no longer receives Claude Code lifecycle events via HTTP hooks. Session metadata (status, session ID, transcript) is now tracked directly via the SDK `query()` stream. All hook-related files have been deleted: `hooks.ts`, `install-hooks.ts`, `api/hooks/route.ts`, `api/hooks/status/route.ts`. The requirements below are historical only.

## Introduction

The Hook Integration feature connects CSM to Claude Code's lifecycle event system. Claude Code emits hook events (such as `UserPromptSubmit` and `Stop`) during its operation, and CSM receives these events via an HTTP API to update session metadata. This is the primary mechanism for capturing the Claude session ID and transcript file path — data that enables the transcript viewer and session observability features. The feature also provides hook installation detection so the UI can warn users when hooks are not configured.

## Requirements

### Requirement 1: Hook Event Reception

**Objective:** As a developer, I want CSM to receive hook events from Claude Code via an HTTP endpoint, so that session metadata is updated automatically during Claude Code operation.

#### Acceptance Criteria

1. The Hook API shall accept POST requests at `/api/hooks` with a JSON body.
2. The Hook API shall validate the request body against the `hookEventDataSchema` using Zod.
3. The Hook API shall return a 200 response with `{ matched: boolean }` indicating whether the event was matched to a managed session.
4. If the request body fails validation, the Hook API shall return a 400 error.

### Requirement 2: Session Matching

**Objective:** As a developer, I want hook events to be matched to the correct session by comparing the working directory, so that metadata updates are applied to the right session.

#### Acceptance Criteria

1. The Hook Processor shall match events to sessions by comparing the `cwd` field to session `worktreePath` values across all projects.
2. If the `cwd` field is missing from the event, the Hook Processor shall return false (no match).
3. If no session's worktree path matches the `cwd`, the Hook Processor shall return false (no match).
4. When multiple projects exist, the Hook Processor shall search across all projects to find the matching session.

### Requirement 3: Session Metadata Update

**Objective:** As a developer, I want matched hook events to update session metadata, so that the Claude session ID and transcript path are captured for observability features.

#### Acceptance Criteria

1. When a hook event includes a `session_id` field and matches a session, the Hook Processor shall update the session's `claudeSessionId`.
2. When a hook event includes a `transcript_path` field and matches a session, the Hook Processor shall update the session's `transcriptPath`.
3. When a hook event matches a session, the Hook Processor shall update the session's `lastActivityAt` timestamp.
4. When a hook event only includes some metadata fields, the Hook Processor shall update only the provided fields (partial update).
5. The Hook Processor shall persist state changes atomically via the state management module.

### Requirement 4: Hook Installation Detection

**Objective:** As a developer, I want CSM to detect whether Claude Code hooks are properly configured, so that the UI can display installation status and guide setup.

#### Acceptance Criteria

1. The Hook Detector shall read Claude Code's global settings file (`~/.claude/settings.json`).
2. The Hook Detector shall check for the presence of both `UserPromptSubmit` and `Stop` hook events.
3. The Hook Detector shall verify that hook commands contain a reference to `csm` in the command string.
4. The Hook Detector shall return a status object with `installed` (true only if both hooks present), `hasUserPromptSubmit`, and `hasStop` fields.
5. If the settings file does not exist or cannot be parsed, the Hook Detector shall return `installed: false` with both event flags false.

### Requirement 5: Hook Status API

**Objective:** As a developer, I want an API endpoint to query hook installation status, so that the UI can display appropriate warnings.

#### Acceptance Criteria

1. The Hook Status API shall accept GET requests at `/api/hooks/status`.
2. The Hook Status API shall return the hook detection result as a JSON response.

### Requirement 6: UI Hook Status Display

**Objective:** As a developer, I want the UI to display hook installation status and warnings, so that I know when hooks need to be configured.

#### Acceptance Criteria

1. When hooks are not installed, the Projects page shall display a warning banner.
2. When hooks are not installed, the Sessions page shall display a warning banner.
3. The UI shall indicate "hooks active" or "hooks missing" status on project pages.
