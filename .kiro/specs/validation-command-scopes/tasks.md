# Implementation Plan

- [x] 1. Establish the scope-aware registry and resolution vocabulary
- [x] 1.1 Replace the flat command registration with the strict logical profile
  - In `src/lib/validation/schemas.ts`, export `validationScopeSchema` / `ValidationScope` for `changed | full` and replace the command string with strict `command: { full: string; changed?: string }`.
  - Rename `scopeArgs` to `pathArgs`, preserve the `forbid` default, and add a schema-level issue when `pathArgs: "paths"` appears without `command.changed`.
  - Make the command profile and nested command object strict so the old string `command`, old `scopeArgs`, unknown keys, and a missing full executable fail parsing.
  - Update registry-shaped fixtures in config parsing, project config loading, preflight, workflow validation prompts, and validation schema tests without changing logical command selection or costs.
  - Done when schema tests prove the accepted shape and every clean-cutover rejection, while pre-merge/lane-merge name validation still works.
  - _Requirements: 1.1–1.5, 3.1, 6.1, 6.4, 6.5_

- [x] 1.2 Rename path validation and add the pure execution resolver
  - Rename `src/lib/validation/scope-args.ts` and its public symbols to `path-args.ts`, `validatePathArgs`, and `PathArgsViolationKind`; preserve option, absolute-path, traversal, and worktree-containment behavior byte-for-byte.
  - Add `src/lib/validation/command-resolution.ts` with one pure `resolveValidationExecution` boundary that receives the parsed profile, requested scope, paths, and worktree path and returns the selected executable, requested/effective scope, path policy, and copied validated paths or a typed pre-admission error.
  - Use exactly `path_args_forbidden`, `path_args_rejected`, and `path_args_require_changed` as service error reasons. Reject all paths for full requests, all paths when no changed executable exists, and forbidden/invalid paths before returning an execution profile.
  - Add table-driven tests for the six approved dispatch combinations plus option-like, absolute, traversal, and outside-worktree paths.
  - Done when no caller outside this resolver chooses between `command.full` and `command.changed`, and no scope value is represented as wrapper argv.
  - _Requirements: 2.3–2.6, 3.1–3.6, 7.1_
  - _Depends: 1.1_

- [x] 2. Persist requested and effective scope without falsifying history
- [x] 2.1 Add the replay-safe validation-run scope migration
  - Add nullable checked `requested_scope` and `effective_scope` columns to `VALIDATION_RUNS_SCHEMA_DDL` in `src/lib/state-store/state-db.ts`.
  - Add `0016-validation-run-scopes.ts` and register it after `0015-mint-graph-workflow-edge-ids`; use the existing additive-column helper and make replay a no-op when each column already exists.
  - Backfill only rows where `scoped = 1` to `changed`/`changed`; leave `scoped = 0` rows null because the old ledger does not prove whether their wrappers ran changed or full.
  - Add a migration test that constructs both legacy row shapes, verifies evidence-preserving backfill, verifies null ambiguity, and reruns the migration to prove idempotence.
  - Done when fresh and pre-column databases share the same floor and no destructive table rebuild or compatibility-version bump is introduced.
  - _Requirements: 5.3, 5.6, 7.3_

- [x] 2.2 Migrate the validation-run domain and repository mapping
  - Replace `ValidationRunRecord.scoped` with nullable `requestedScope` and `effectiveScope`; retain `scopedPathCount` as the explicit-path timing dimension.
  - Extend validation-run SQL row parsing, inserts, and read mapping for both scope columns. Keep the legacy `scoped` SQLite column as an internal additive-migration artifact and derive new writes from `scopedPathCount > 0`.
  - Update the durability contract's maximal fixture to non-default `changed`/`full` values and update scheduler, lease, recovery, service, shared-budget, singleton, and migration fixtures to provide scope values appropriate to each new run.
  - Test a legacy null-scope row separately from the maximal round-trip because every new submission must carry non-null requested/effective scope even though the read schema admits old nulls.
  - Done when repository round trips preserve both scopes and path count, and startup recovery still reads/interrupts old rows.
  - _Requirements: 5.3–5.6, 7.3, 7.5_
  - _Depends: 2.1_

- [x] 3. Route all execution through the resolved immutable profile
- [x] 3.1 Make the process runner consume, not decide, scope
  - Change `SpawnValidationParams` to carry the already-selected executable plus `requestedScope`, `effectiveScope`, `pathArgs`, and `scopePaths`.
  - Retain defense-in-depth path validation and add an invariant failure for paths when effective scope is not changed; rename runner error variants from `scope_args_*` to `path_args_*`.
  - Continue resolving executable paths from the canonical project root, checking execute permission, invoking the supervisor with an argv array, and appending only validated paths. Do not forward requested/effective scope as argv or add a shell.
  - Add requested/effective scope and path count to existing structured runner logs; preserve process-group, timeout, cancellation, and bounded-output behavior.
  - Done when runner tests prove the selected full/changed path reaches the supervisor, paths only reach changed runs, scope never reaches argv, and all existing lifecycle tests remain green.
  - _Requirements: 1.5, 2.6, 3.2–3.6, 5.5, 7.1, 7.3, 7.4_
  - _Depends: 1.2_

- [x] 3.2 Centralize agent and system submission resolution in `ValidationService`
  - Add optional `scope` to `ValidationSubmitRequest` and normalize omission to `changed`; add required `scope` to `ValidationSystemSubmitRequest`.
  - After identity and logical-name lookup but before policy/admission, call `resolveValidationExecution` for both `submit` and `submitSystem`; remove duplicated direct reads of the flat executable and direct path preflight.
  - Snapshot the selected executable, requested/effective scope, shared cost, and shared timeout in the prepared spawn and ledger submission before the scheduler call. Return both non-null scopes on every accepted submission.
  - Preserve command-not-found, policy skip, fail-fast/wait admission, oversized-cost, lease, shutdown, cancellation, and queue-pump behavior. A queued run must continue using its prepared resolved profile after live config edits.
  - Update service tests for default changed/native, explicit changed/native, changed→full fallback, explicit full, changed paths, all three path errors, system changed fallback, and config mutation after queuing.
  - Done when `ValidationService` is the only production module that combines registry profiles with caller scope and every accepted new ledger row has both scope values.
  - _Requirements: 2.1–2.6, 3.1–3.6, 4.2–4.4, 5.3–5.5, 7.2, 7.3, 7.5_
  - _Depends: 2.2, 3.1_

- [x] 3.3 Project scope through API, discovery, status, events, and logs
  - Add defaulted `scope` to `validationSubmitBodySchema`; replace public `scopeArgs` with `pathArgs`; expose `changedScope: "native" | "full_fallback"` without exposing either executable.
  - Add requested/effective scope to accepted submissions, active-run items, and poll responses. Poll/list fields are nullable only for legacy ledger rows; accepted fields are non-null.
  - Extend validation lifecycle events with requested scope and nullable effective scope: pre-lookup rejection has no effective scope, while queued/started/completed/cancelled/interrupted events use the resolved scope snapshot.
  - Map the three resolver errors to HTTP 400 codes `validation_path_args_forbidden`, `validation_path_args_rejected`, and `validation_path_args_require_changed`.
  - Add both scopes and `scopedPathCount` to existing request/queue/start/completion structured logs and remove the misleading `scoped` boolean from new observability.
  - Update route/service/event tests to assert scope fields and to assert serialized responses never contain the registered `command` object, variant path fields, or executable path strings.
  - Done when operators can distinguish native changed from changed→full fallback through list/status/logs while the trust boundary remains opaque.
  - _Requirements: 5.1–5.6, 7.1–7.5_
  - _Depends: 3.2_

- [x] 4. Standardize CLI and automated callers
- [x] 4.1 Add `--scope changed|full` to `cctl validate run`
  - Declare one `scope` value flag in `src/cli/commands/validate.help.ts`; update usage and examples so the help registry remains the parser allowlist and documentation source.
  - In `validate.ts`, normalize an omitted flag to changed, reject other values with exit 2, reject full plus `--` paths locally, and send the explicit normalized scope in every submit body.
  - Render native/fallback support in `validate list`; render requested/effective scope in active and single-run status. Preserve quiet human success output, and include both fields in JSON terminal envelopes by carrying accepted scope metadata through polling.
  - Update CLI tests for default changed, explicit full, explicit changed paths, invalid value, full/path rejection without a network request, fallback discovery, status, JSON, lease polling, signal cancellation, and executable-path non-disclosure.
  - Done when `cctl validate run test` and `--scope changed` are equivalent requests and `--scope full` selects the same logical command with no separate full-suite name.
  - _Requirements: 2.1–2.3, 3.1–3.6, 4.1, 5.1, 5.2_
  - _Depends: 3.3_

- [x] 4.2 Make every orchestrator submission explicitly changed
  - Pass `scope: "changed"` from `src/lib/workflow-graph/script-validator-runner.ts` and `src/lib/workflows/validation-fix/actors.ts`; this covers graph script validation, lane merge, Smart Merge, and Smart Commit through their existing sources.
  - Keep workflow definitions, `validation.preMerge`, `validation.laneMerge`, selectors, gates, and fix-loop facts keyed only by logical command names.
  - Update caller tests and every `submitSystem` fake/fixture to require and assert changed scope; add a full-only registry case proving the service—not the caller—resolves effective full.
  - Update the workflow validation prompt to state that runs default to changed, `--scope full` requests full evidence, and full-only commands fall back automatically; preserve policy and capacity guidance.
  - Done when no production `submitSystem` call omits scope and no automated caller selects a variant name or executable.
  - _Requirements: 4.2–4.4, 6.3, 6.4, 7.2_
  - _Depends: 3.2, 4.1_

- [x] 5. Cut this repository over to one logical profile per command
- [x] 5.1 Add full format, lint, and pre-merge executables
  - Add executable `scripts/validate/format-full.sh` using `common.sh` and quiet full-repository Prettier write; add executable `scripts/validate/lint-full.sh` using `common.sh` and quiet full-repository ESLint fix with existing color/warning flags.
  - Add executable `scripts/pre-merge-validate-full.sh` that establishes the shared scratch config directory and sequentially runs full format, full lint, full typecheck, and `test-full-suite.sh` within the one cost-8 composite reservation.
  - Keep `format.sh`, `lint.sh`, `test.sh`, and `pre-merge-validate.sh` as changed implementations. Keep typecheck full-only. Preserve Vitest setup-file widening and the shared eight-worker/heap profile.
  - Update wrapper contract tests to stub tools and prove changed variants narrow, full variants ignore a narrow merge-base diff, full test disables bail, both test variants share resource settings, and every new script is executable.
  - Done when each project wrapper has one fixed behavior and none parses a Command Center scope argument.
  - _Requirements: 1.2, 1.3, 2.6, 6.2–6.4, 7.4_
  - _Depends: 3.2_

- [x] 5.2 Atomically migrate `CommandCenter.json` and repository config contracts
  - Preserve `initScriptPath` and both `devServers` entries unchanged.
  - Register `pre-merge`, `format`, `lint`, and `test` with both nested variants; register `typecheck` with only `command.full`; rename `scopeArgs` to `pathArgs` on `test`.
  - Keep the existing shared costs/timeouts, use scope-neutral descriptions, keep `preMerge` and `laneMerge` logical-name lists unchanged, and remove only the `test-full-suite` logical registry entry.
  - Update project-config, config-schema, preflight, wrapper, and instruction-doc tests to assert the exact new profile and absence of the old logical name/fields.
  - Done when the repository config parses only through the new schema, every selected policy name remains registered, and `test.command.changed` still reaches Vitest native affected mode.
  - _Requirements: 1.1–1.4, 5.5, 6.1–6.5_
  - _Depends: 1.1, 5.1_

- [x] 6. Synchronize documentation, setup guidance, and generated CLI reference
  - Update `docs/project-configuration.md`, `docs/ai-validation-output.md`, `.kiro/steering/project-configuration.md`, and the validation-concurrency design with the nested profile, default changed behavior, full fallback, `pathArgs`, discovery metadata, and requested/effective ledger semantics.
  - Update the project-setup skill and its commandcenter-json, pre-merge, Vitest, Jest, ESLint, Prettier, and TypeScript references so generated projects produce separate fixed variants and never teach wrappers to parse CC scope.
  - Update the dev-server setup commandcenter-json reference because it also documents the project schema. Do not rewrite historical reports.
  - Run `bun scripts/cc-cli-skill-reference.ts` after changing the help registry, then update instruction-document assertions and run the generator in `--check` mode.
  - Done when repository search finds no live flat validation registration, `scopeArgs`, `test-full-suite` logical guidance, or stale `cctl validate run` usage outside intentionally historical reports/migration compatibility internals.
  - _Requirements: 5.1, 6.1–6.5_
  - _Depends: 4.1, 5.2_

- [x] 7. Validate the clean cutover end to end
- [x] 7.1 Run targeted contract and regression validation
  - Run targeted Vitest files for schemas/resolver, API/routes, service, runner, scheduler/lease/recovery, repository/migration, CLI, orchestrator callers, workflow prompt, wrappers, and instruction docs.
  - Run typecheck and lint after targeted tests; fix only regressions caused by this feature and preserve unrelated worktree changes.
  - Verify executable modes, wrapper shebangs, policy-list registration, shared costs/timeouts, fixed Vitest worker/heap enforcement, quiet success, complete colorless failure output, and executable-path non-disclosure.
  - Done when all targeted tests, typecheck, lint, generated-reference check, and repository invariants pass.
  - _Requirements: 1–7_
  - _Depends: 2.2, 3.3, 4.2, 6_

- [x] 7.2 Exercise native changed, full fallback, explicit full, and path narrowing
  - Verify `test` default/changed selects the changed wrapper and its launcher supplies Vitest's native `changed` option with the merge base.
  - Verify `typecheck` requested changed reports effective full, `test --scope full` selects the full wrapper, and `test --scope changed -- <path>` forwards only the validated path.
  - Verify full plus paths and a path request against a full-only command fail before admission, and discovery never returns executable paths.
  - Run the repository's registered format, lint, typecheck, changed test, and full test validations through the new logical interface wherever the running branch server can exercise the cutover; record any main-server bootstrap limitation separately rather than adding compatibility code.
  - Done when the four scope behaviors and the two fail-closed path cases have automated evidence, and the changed test path is proven to use Vitest's affected-file implementation.
  - _Requirements: 2.1–2.6, 3.1–3.6, 5.1–5.5, 6.3, 7.1–7.5_
  - _Depends: 7.1_

## Implementation Constraints

- No new runtime dependency, shell execution, raw option passthrough, alternate scheduler path, scope-specific resource profile, or backward-compatible registry parser.
- Keep all production logging in the existing `validation` or `state-store.validation-runs` structured logger vocabulary; add fields to existing lifecycle events rather than inventing noisy duplicates.
- Use dependency injection and pure functions in tests; do not add `vi.mock()` for internal validation modules.
- Existing comments remain unless proven false; changed comments describe only the resulting behavior and never the migration history.
- The config cutover is last among code changes so the current registered commands remain usable while the new parser/service/CLI are being built.
