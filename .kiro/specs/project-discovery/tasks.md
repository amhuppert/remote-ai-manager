# Implementation Plan

- [x] 1. Test the discovery service scanning and filtering logic
- [x] 1.1 (P) Verify directory scanning identifies git repositories one level deep
  - Set up a mock base directory with a mix of git repos, non-git directories, plain files, and directories matching ignore patterns
  - Confirm only directories containing a `.git` entry are returned as discovered projects
  - Confirm non-directory entries are silently skipped
  - Confirm directories matching any configured ignore pattern are excluded
  - Confirm an empty list is returned when the base directory does not exist
  - Follow the existing `config.test.ts` pattern: mock `node:os` to redirect `homedir()`, use temp dirs in `/tmp`, `vi.resetModules()` between tests
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 1.2 (P) Verify session metadata enrichment on discovered projects
  - Mock or create a state file that associates sessions with specific project paths
  - Confirm each discovered project includes name, absolute path, active session count, and running session indicator
  - Confirm non-archived sessions are counted as active sessions
  - Confirm a project with at least one session in `"running"` status has `hasRunningSession` set to `true`
  - Confirm a project with no entry in manager state returns `activeSessions: 0` and `hasRunningSession: false`
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 1.3 Verify result ordering by activity and name
  - Confirm projects with active sessions appear before projects with no active sessions
  - Confirm projects within the same activity tier are sorted alphabetically using locale-aware comparison
  - Test with multiple projects spanning both tiers to validate stable ordering
  - Depends on scanning (1.1) and enrichment (1.2) since ordering tests require populated project data
  - _Requirements: 3.1, 3.2_

- [x] 2. Test the project name resolution logic
- [x] 2.1 (P) Verify project name resolves to a validated filesystem path
  - Set up a temp base directory with a valid git repo (directory with `.git`), a directory without `.git`, and a missing directory
  - Confirm a valid project name returns the absolute filesystem path
  - Confirm a project name pointing to a non-existent directory returns `null`
  - Confirm a project name pointing to a directory without `.git` returns `null`
  - Follow the same mocking approach as config tests (mock `node:os`, temp dirs, `vi.resetModules()`)
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 3. Verify existing configuration service test coverage
- [x] 3.1 (P) Audit and extend config tests for full requirement coverage
  - Review existing `config.test.ts` for coverage of OS-appropriate directory selection, default creation, merge-with-defaults, and schema validation
  - Add any missing assertions: verify the config directory path follows OS conventions (the existing test validates "path under home" but not platform branching)
  - Confirm the config validation uses safe parsing against `globalConfigSchema` (verify malformed config falls back to defaults rather than throwing)
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 4. Validate the projects API endpoint behavior
- [x] 4.1 Verify GET /api/projects returns correct responses
  - Confirm the route returns a JSON array of discovered projects with status 200 on success
  - Confirm response caching is disabled via `force-dynamic` export
  - Confirm an error during discovery returns a JSON object with an `error` field and HTTP status 500
  - This task depends on the discovery service tests (task 1) being complete to ensure the underlying logic is validated
  - _Requirements: 6.1, 6.2, 6.3_
