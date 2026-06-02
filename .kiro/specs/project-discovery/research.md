# Research & Design Decisions

## Summary

- **Feature**: `project-discovery`
- **Discovery Scope**: Extension (existing, fully implemented feature)
- **Key Findings**:
  - Feature is already implemented across 4 modules with clear separation of concerns
  - No new dependencies needed — uses only Node.js built-ins and existing project libraries (Zod v4)
  - State enrichment couples discovery to the manager state module but keeps the coupling read-only

## Research Log

### Existing Module Boundaries

- **Context**: Understanding how the feature's responsibilities are distributed across existing files
- **Sources Consulted**: `src/lib/discovery.ts`, `src/lib/project-resolver.ts`, `src/lib/config.ts`, `src/app/api/projects/route.ts`
- **Findings**:
  - `discovery.ts` — single exported function `discoverProjects()`, handles scanning + enrichment + sorting
  - `project-resolver.ts` — single exported function `resolveProjectPath()`, used by downstream API routes
  - `config.ts` — shared config service consumed by both discovery and resolver
  - `route.ts` — thin API handler that delegates entirely to `discoverProjects()`
- **Implications**: Clean boundaries already exist; design should formalize these as contracts

### Dependency Chain

- **Context**: Mapping how discovery modules depend on other parts of the system
- **Sources Consulted**: Import analysis of all 4 modules
- **Findings**:
  - `discovery.ts` depends on `config.ts` (read-only) and `state.ts` (read-only)
  - `project-resolver.ts` depends on `config.ts` (read-only)
  - Neither module writes state — they are pure consumers
  - `DiscoveredProject` interface lives in `src/lib/projects/schemas.ts` (not derived from Zod)
  - `GlobalConfig` is Zod-derived from `src/lib/config/schemas.ts`
- **Implications**: Read-only dependencies simplify testing and reduce risk of side effects

### Testing Patterns

- **Context**: How existing tests handle filesystem dependencies
- **Sources Consulted**: `src/lib/config.test.ts`
- **Findings**:
  - Tests use `vi.mock("node:os")` to redirect `homedir()` to a temp directory
  - `vi.resetModules()` used between tests to reset module-level constants (`CONFIG_DIR`)
  - Temp directories created in `/tmp` with timestamp-based names for isolation
  - No discovery-specific tests exist yet
- **Implications**: Same mocking pattern should be used for discovery tests

## Architecture Pattern Evaluation

| Option                | Description                                    | Strengths                                         | Risks / Limitations                | Notes                                     |
| --------------------- | ---------------------------------------------- | ------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Current flat modules  | Independent functions in flat `src/lib/` files | Simple, matches project conventions, easy to test | No formal service abstraction      | Already implemented; aligns with steering |
| Service class pattern | Wrap functions in injectable service classes   | Better DI for testing                             | Over-engineering for current scale | Not aligned with project conventions      |

## Design Decisions

### Decision: Keep Flat Function Exports

- **Context**: Whether to wrap discovery logic in classes or keep as exported functions
- **Alternatives Considered**:
  1. Service class with constructor injection — more testable but adds abstraction layer
  2. Flat async functions with module-level dependencies — current approach
- **Selected Approach**: Keep flat functions, matching existing `src/lib/` conventions
- **Rationale**: Project steering explicitly describes "flat lib" pattern; all other modules follow this convention
- **Trade-offs**: Module-level mocking required for tests (vs constructor injection), but this is the established pattern
- **Follow-up**: Verify test coverage for discovery and resolver modules

### Decision: DiscoveredProject as Plain Interface

- **Context**: `DiscoveredProject` is defined as a TypeScript interface in `src/lib/projects/schemas.ts`, not as a Zod schema
- **Alternatives Considered**:
  1. Add a Zod schema for `DiscoveredProject` — would enable runtime validation of API responses
  2. Keep as plain interface — simpler, sufficient for internal-only type
- **Selected Approach**: Keep as plain interface
- **Rationale**: `DiscoveredProject` is constructed internally by `discoverProjects()`, not parsed from external input. The project convention uses Zod schemas for data parsed from disk/network, and plain interfaces for internally-constructed types.
- **Trade-offs**: No runtime validation of the API response shape, but the type is fully controlled internally
- **Follow-up**: None needed

## Risks & Mitigations

- **Filesystem race conditions**: Directory entries could change between `readdir` and `stat` calls — mitigated by treating `stat` failures as "no .git, skip" rather than throwing
- **Large base directories**: Scanning hundreds of entries is sequential — acceptable for expected scale (tens of repos), but could become slow. Mitigation: no action needed now, but parallelization is straightforward if needed
- **State file missing**: `readState()` already returns empty state if file is absent, so discovery gracefully shows zero sessions

## References

- [Next.js App Router Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers) — API route conventions
- [Zod v4 Documentation](https://zod.dev) — Schema validation patterns
