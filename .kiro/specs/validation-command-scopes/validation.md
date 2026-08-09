# Validation Report

## Automated evidence

- Targeted Vitest: 33 files and 485 tests passed across registry schemas, command resolution, service/API/CLI dispatch, persistence and migration, automated callers, workflow prompts, and real shell wrappers.
- Follow-up contracts: 5 files and 97 tests passed after the final documentation, ledger-fixture, and shared test-resource assertions.
- TypeScript: `npx tsc --noEmit --pretty false` passed.
- ESLint: `npx eslint . --quiet --no-color --no-warn-ignored` passed.
- Architecture ratchet: `bun run seams:check` passed.
- Generated CLI reference: `bun scripts/cc-cli-skill-reference.ts --check` passed.
- Repository invariants: `git diff --check` passed; all added wrappers are executable; the checked-in `CommandCenter.json` parses through the production schema with only `pre-merge`, `format`, `lint`, `typecheck`, and `test` logical names.

## Scope scenarios

- Native changed: the `test` profile selects `scripts/validate/test.sh`; the real wrapper test observes the launcher receiving `changed both <merge-base>`, which becomes Vitest's native `changed` option.
- Changed fallback: the full-only `typecheck` profile records requested `changed`, effective `full`, and selects `scripts/validate/typecheck.sh` in service tests.
- Explicit full: the same logical `test` profile records requested/effective `full` and selects `scripts/validate/test-full-suite.sh`.
- Path narrowing: validated paths reach only native changed executions. Full plus paths, fallback plus paths, forbidden paths, and unsafe paths fail before scheduler admission.
- Immutable queued profile: a queued run retains its selected executable and effective scope after a live registry value changes.
- Non-disclosure: discovery/list schemas expose `pathArgs` and native/fallback support without either executable path.

## Running Command Center limitation

The installed/running Command Center process predates this branch. Its live `cctl validate list --json` response still uses flat registrations and the separate `test-full-suite` logical name. `cctl dev ensure` rejects this branch's nested command objects with `expected string, received object` before a branch server can start.

This is the expected clean-cutover bootstrap boundary: the approved requirements explicitly reject a backward-compatible parser. No live validation run was submitted to the old server, and no production state was mutated. The real process boundary is instead exercised by the shell-wrapper tests, while the real SQLite write/read/restart boundary is exercised by the repository and migration contracts.
