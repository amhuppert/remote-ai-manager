# Requirements Document

## Introduction

Project Discovery is the foundational feature of CSM (Claude Session Manager) that scans a configurable base directory for git repositories and surfaces them as manageable projects. It provides both a discovery engine (scanning the filesystem for repos) and a resolution layer (mapping project names from URLs to validated filesystem paths). The feature enriches discovered projects with session metadata from the manager state, enabling the dashboard to show active session counts and running status at a glance.

## Requirements

### Requirement 1: Directory Scanning

**Objective:** As a developer, I want CSM to automatically find all git repositories in my projects directory, so that I don't have to manually register each project.

#### Acceptance Criteria

1. When the Discovery Service scans the base directory, the Discovery Service shall enumerate only immediate child directories (one level deep) and identify those containing a `.git` directory or file as git repositories.
2. When a child directory does not contain a `.git` entry, the Discovery Service shall exclude it from the results.
3. When a child entry is a file (not a directory), the Discovery Service shall skip it without error.
4. When a directory name matches any pattern in the configured `ignorePatterns` list, the Discovery Service shall exclude it from the results.
5. If the configured base directory does not exist, the Discovery Service shall return an empty project list without throwing an error.

### Requirement 2: Project Metadata Enrichment

**Objective:** As a developer, I want each discovered project to include session activity information, so that I can quickly see which projects have active work.

#### Acceptance Criteria

1. The Discovery Service shall return each project with: name (directory name), absolute path, active session count, and running session indicator.
2. When a project has sessions in the manager state, the Discovery Service shall count non-archived sessions as the `activeSessions` value.
3. When any session within a project has status `"running"`, the Discovery Service shall set `hasRunningSession` to `true`.
4. When a project has no entry in the manager state, the Discovery Service shall return `activeSessions: 0` and `hasRunningSession: false`.

### Requirement 3: Result Ordering

**Objective:** As a developer, I want projects with active sessions to appear first, so that I can quickly access the work I'm currently engaged with.

#### Acceptance Criteria

1. The Discovery Service shall sort projects with active sessions (activeSessions > 0) before projects with no active sessions.
2. While two projects have the same activity tier (both active or both inactive), the Discovery Service shall sort them alphabetically by name using locale-aware comparison.

### Requirement 4: Project Name Resolution

**Objective:** As a developer navigating the dashboard, I want project names from URLs to resolve reliably to filesystem paths, so that the application can serve project-specific pages.

#### Acceptance Criteria

1. When a valid project name is provided, the Project Resolver shall return the absolute filesystem path by joining the configured base directory with the project name.
2. When the resolved path does not exist on the filesystem, the Project Resolver shall return `null`.
3. When the resolved path exists but does not contain a `.git` entry, the Project Resolver shall return `null`.

### Requirement 5: Configuration

**Objective:** As a developer, I want the base directory and ignore patterns to be configurable, so that CSM works with my filesystem layout.

#### Acceptance Criteria

1. The Configuration Service shall store settings in an OS-appropriate config directory (macOS: `~/Library/Application Support/csm`, Linux: `$XDG_CONFIG_HOME/csm` or `~/.config/csm`).
2. If no config file exists, the Configuration Service shall create one with default values: `baseDir` as `~/projects`, and a standard set of ignore patterns (`node_modules`, `.next`, `dist`, `build`, `target`, `.cache`, `.turbo`, `.venv`).
3. When the config file exists but has missing fields, the Configuration Service shall merge the file contents with defaults so that missing fields fall back to default values.
4. The Configuration Service shall validate the config file contents against the `globalConfigSchema` using safe parsing.

### Requirement 6: API Endpoint

**Objective:** As a frontend consumer, I want a REST API to retrieve the project list, so that the dashboard can display discovered projects.

#### Acceptance Criteria

1. When a GET request is made to `/api/projects`, the Projects API shall return a JSON array of discovered projects with status 200.
2. The Projects API shall disable response caching (`force-dynamic`) to ensure fresh discovery results on each request.
3. If an error occurs during discovery, the Projects API shall return a JSON object with an `error` field and HTTP status 500.
