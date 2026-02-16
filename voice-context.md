# Voice-to-Text Context

## Project

Claude Session Manager (CSM) — A Next.js application that manages Claude AI sessions across multiple projects, tracking worktrees, branches, transcripts, and session state.

## Technologies

- **Next.js** — React framework with App Router (v15.1.0)
- **React** — UI library (v19.0.0)
- **TypeScript** — Language and type system (v5.7.0)
- **Zod** — Schema validation library (v4.3.6) — note: v4 syntax differs from v3
- **Vitest** — Unit testing framework (v2.1.0)

## Terminology

- **CSM** - Claude Session Manager, the project name
- **SessionState** - Data structure tracking a single Claude session (name, branch, status, etc.)
- **SessionStatus** - Enum: "idle", "ready", "running"
- **Worktree** - Git worktree path associated with a session
- **BranchName** - Git branch name in a worktree
- **ClaudeSessionId** - Unique identifier for a Claude AI session
- **TranscriptPath** - File path to session transcript
- **GlobalConfig** - Application-wide configuration (baseDir, ignorePatterns, stateFilePath, claudeTimeoutMs)
- **PerRepoConfig** - Per-repository configuration (initScriptPath)
- **ProjectState** - State container for a single project with multiple sessions
- **ManagerState** - Root state container managing multiple projects
- **HookEventData** - Event data from Claude Code hooks

## Kiro Commands

- **/kiro:spec-init** - Initialize a new specification with detailed project description
- **/kiro:spec-requirements** - Generate comprehensive requirements for a specification
- **/kiro:spec-design** - Create comprehensive technical design for a specification
- **/kiro:validate-design** - Interactive technical design quality review and validation
- **/kiro:spec-tasks** - Generate implementation tasks for a specification
- **/kiro:spec-impl** - Execute spec tasks using TDD methodology
- **/kiro:spec-status** - Show specification status and progress
- **/kiro:validate-impl** - Validate implementation against requirements, design, and tasks
- **/kiro:validate-gap** - Analyze implementation gap between requirements and existing codebase
- **/kiro:steering** - Manage .kiro/steering/ as persistent project knowledge
- **/kiro:steering-custom** - Create custom steering documents for specialized project contexts

## Notable Files and Directories

- `ui-design/index.html` - The design prototype file
- `memory-bank/design-system.md` - The design system file

## Naming Conventions

Camel case for variables and functions (e.g., `sessionName`, `claudeTimeoutMs`, `baseDir`). Pascal case for types and schema names (e.g., `SessionState`, `GlobalConfig`, `ProjectState`). Boolean fields use "is" or "has" prefixes sparingly.
