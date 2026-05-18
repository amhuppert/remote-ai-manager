# Implementation Plan

This plan delivers configurable agent capabilities end to end: five backend-specific cascades, native default discovery, sparse overrides, plugin parent-child disable behavior, conversation-start composition, runtime apply/staging, five UI panels, diagnostics, and cross-client synchronization.

Implementation follows red-green-refactor by default. Each task should add focused failing coverage first unless the work is a narrow wiring change or Storybook prototype.

- [ ] 1. Verify backend capability gates

- [x] 1.1 (P) Verify Codex skill and plugin runtime emission
  - Prove that Codex skill and plugin overrides can be translated into next-turn runtime configuration before editable runtime behavior is enabled.
  - Confirm the concrete Codex skill inventory sources from the design and capture source-signature behavior.
  - Keep Codex Plugins unavailable with diagnostics until authoritative plugin discovery and config emission are verified.
  - Stop Codex plugin runtime implementation and surface the decision if verification fails; do not ship configuration-only toggles as working runtime support.
  - This can run in parallel with Claude primitive verification because it is isolated to Codex discovery and translation behavior.
  - _Requirements: 3.1, 3.3, 3.4, 7.1, 7.2, 8.2, 10.1, 10.3, 12.1, 16.2_

- [x] 1.2 (P) Verify Claude sub-agent suppression
  - Prove the supported strategy for disabling Claude sub-agents before claiming direct sub-agent support.
  - Prefer a native or session-level exclusion primitive when available; otherwise verify a permission-layer denial path for disabled agent invocations.
  - Record unsupported apply points accurately so unsupported live behavior is visible instead of silently ignored.
  - Stop implementation and surface the decision if no suppression path can be verified.
  - This can run in parallel with Codex verification because it is isolated to Claude agent behavior.
  - _Requirements: 4.1, 8.1, 9.3, 12.1, 12.2, 13.3_

- [x] 1.3 (P) Verify Claude native plugin setting preservation
  - Prove that plugin enablement translation preserves native extended plugin values by omitting flag-layer overrides when the resolved state matches the native state.
  - Prove that disabling a natively enabled plugin emits only the minimal disable override.
  - Prove that clearing every CC override restores native plugin behavior without writing backend-owned configuration files.
  - This can run in parallel with the other gate tasks because it is isolated to Claude plugin translation behavior.
  - _Requirements: 3.1, 3.2, 4.2, 8.1, 9.1, 16.3_

- [ ] 2. Establish schemas and metadata

- [x] 2.1 Add persistent capability override and runtime state schemas
  - Define the five cascade kinds and sparse item override records with required enabled values when an item key exists.
  - Add optional project, session, and conversation override fields while preserving existing state compatibility.
  - Add conversation runtime apply state for applied hashes, pending hashes, pending item ids, apply disposition, and sanitized apply errors.
  - Derive all exported types from schemas and reject invalid cascade/backend combinations at schema or metadata boundaries.
  - _Requirements: 1.1, 1.2, 4.1, 4.2, 6.1, 13.1, 14.2, 16.3_

- [x] 2.2 Add API, view, diagnostics, and SSE schemas
  - Define patch requests with set, reset, batch operations, and expected-hash conflict protection.
  - Define resolved view rows with native default, own effective state, final effective state, origin layer, stale state, runtime visibility, runtime-emittable status, inherited-disable reason, and apply status.
  - Define structured diagnostics and SSE payloads that carry cascade, layer, item, backend, and invalidation hints without leaking native config payloads.
  - Add schema tests for invalid payloads, stale item ids, and status enum values.
  - _Requirements: 4.4, 5.2, 6.4, 7.2, 7.3, 9.4, 10.3, 11.2, 13.2, 15.2, 16.2, 16.3_

- [x] 2.3 Add metadata records for all supported cascades
  - Declare exactly one metadata record for each cascade kind.
  - Encode backend ownership, capability kind, authoritative discovery status, runtime visibility, composition support, and apply semantics.
  - Represent verification-gated Codex plugin support and unsupported/deferred Claude agent behavior through metadata rather than UI or runtime conditionals.
  - Add tests proving future backend support can be added through metadata records without scattering backend checks.
  - _Requirements: 1.3, 1.4, 10.4, 12.1, 12.2, 12.3, 12.4_

- [ ] 3. Implement patching and persistence

- [x] 3.1 Implement pure override patch behavior
  - Apply set and reset operations without mutating the input override state.
  - Preserve sibling items, parent plugins, unrelated cascades, and unrelated layers when one item changes.
  - Prune empty item and cascade records after resets.
  - Accept unknown item ids so stale overrides can be displayed later.
  - Cover set, reset, batch, pruning, stale id, and invalid operation cases with direct unit tests.
  - _Requirements: 4.1, 4.2, 4.3, 6.1, 6.2, 13.1, 13.2, 14.1_

- [x] 3.2 (P) Add global override persistence
  - Persist global overrides in the OS-aware Command Center config area with atomic write-temp-rename behavior.
  - Treat a missing global file as empty override state.
  - Re-read or validate written state before reporting success.
  - Surface read, parse, and write failures through structured diagnostics without corrupting prior state.
  - This can run in parallel with scoped persistence after schema and patch behavior are in place because it writes a separate storage boundary.
  - _Requirements: 1.1, 1.2, 14.1, 14.2, 14.3, 16.1, 16.2_

- [x] 3.3 (P) Add project, session, and conversation override persistence
  - Store lower-layer overrides in the existing state hierarchy as optional additive fields.
  - Read and write each layer independently so a narrow edit never persists a full resolved view.
  - Use the existing serialized state mutation boundary to keep writes atomic.
  - Preserve existing state records on read and write.
  - This can run in parallel with global persistence because it uses the existing state boundary instead of the global config file.
  - _Requirements: 1.1, 1.2, 2.1, 14.1, 14.2, 14.3_

- [x] 3.4 Add mutation service conflict handling and change fanout metadata
  - Apply patch batches all-or-nothing at one layer.
  - Compare expected hashes against the current effective hash and return a conflict response with the latest view when stale.
  - Return changed item ids and affected cascade information for runtime apply and SSE fanout.
  - Log accepted, rejected, and failed mutations with structured context and sanitized errors.
  - _Requirements: 6.2, 6.3, 6.4, 15.1, 15.2, 15.3, 16.1, 16.2_

- [ ] 4. Implement cascade resolution

- [x] 4.1 Resolve four-layer inheritance and native defaults
  - Resolve global, project, session, and conversation layers in order with the narrowest explicit item value winning.
  - Fall back to the native default when no CC override exists.
  - Preserve the origin layer and current-layer value separately from inherited effective value.
  - Produce deterministic effective hashes from stable normalized inputs.
  - Add unit tests for precedence, fallback, origin layer, and determinism.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 4.4_

- [x] 4.2 Preserve stale override intent while excluding unavailable runtime rows
  - Include stale rows for override ids missing from current discovery.
  - Preserve the stored stale override value and origin layer in the view.
  - Mark stale and unavailable rows as not runtime-emittable so conversation composition omits them.
  - Add tests proving stale rows survive discovery loss and become active again if discovery later returns the item.
  - _Requirements: 7.2, 8.3, 13.2, 16.2_

- [x] 4.3 Implement plugin parent-child disable semantics
  - Resolve plugin rows before resolving child skill and agent rows for a backend.
  - Force plugin-owned child items disabled when their parent plugin resolves disabled.
  - Preserve each child's own effective state so re-enabling the parent restores the child state.
  - Show inherited-disable reason with parent plugin id and origin layer.
  - Add tests for parent disable, narrower parent re-enable, child override preservation, and sibling isolation.
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 4.4 Attach runtime status to resolved rows
  - Merge runtime visibility and pending apply records into the resolved view.
  - Distinguish applied, staged for idle, staged for next turn, deferred to next conversation, unsupported, rejected, and no-status rows.
  - Keep runtime status calculation data-driven from metadata and runtime apply state.
  - Add tests for Claude idle staging, Codex next-turn staging, unsupported apply paths, and failed apply diagnostics.
  - _Requirements: 7.3, 9.4, 10.3, 11.2, 12.3, 16.2_

- [ ] 5. Implement native discovery

- [x] 5.1 (P) Add Claude capability discovery
  - Discover Claude skills, plugins, and sub-agents from native read-only sources and runtime-visible SDK methods when available.
  - Compute native defaults without mutating backend-owned files.
  - Record plugin ownership links for contributed skills and agents.
  - Preserve adapter-private native plugin metadata needed for minimal flag-settings translation without returning full payloads in API responses.
  - Surface missing, unreadable, malformed, and runtime probe failures as diagnostics.
  - This can run in parallel with Codex discovery because the adapters read different backend sources.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.4, 7.1, 7.3, 7.4, 16.1, 16.3_

- [x] 5.2 (P) Add Codex capability discovery and unavailable plugin handling
  - Discover Codex skills from project, user, and system skill locations declared in the design.
  - Represent Codex plugin discovery as unavailable until authoritative installed/enabled plugin sources are verified.
  - Return diagnostics that keep the Codex Plugins panel present but non-editable before verification.
  - Keep source reads read-only and treat discovery failures as non-blocking diagnostics.
  - This can run in parallel with Claude discovery because the adapters read different backend sources.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 7.1, 7.2, 7.4, 11.1, 12.1, 16.2_

- [x] 5.3 Add discovery caching and refresh behavior
  - Cache discovery by cascade, scope context, and source signature.
  - Invalidate cache entries when source signatures change or the user requests refresh.
  - Ensure one cascade's discovery failure does not discard successful discovery for other cascades.
  - Log discovery refresh and failure events with correlation context.
  - _Requirements: 3.3, 3.4, 7.2, 7.4, 15.1, 16.1, 16.2, 16.3_

- [ ] 6. Compose runtime capability configuration

- [x] 6.1 Build backend-scoped conversation-start composition
  - Resolve only the cascades owned by the active conversation backend.
  - Omit stale, unavailable, and failed-composition rows from emitted runtime config while preserving diagnostics.
  - Fall back to native defaults for only the cascade kind that fails composition.
  - Seed runtime hashes when a conversation runtime is created.
  - Add tests proving composition is deterministic and does not require a real agent process.
  - _Requirements: 1.3, 2.4, 2.5, 8.1, 8.2, 8.3, 8.4, 13.3_

- [x] 6.2 (P) Add Claude runtime translation
  - Translate effective Claude skill and plugin state into SDK flag settings.
  - Emit minimal plugin enablement deltas that preserve native extended plugin settings by omission where possible.
  - Represent Claude sub-agent support according to the verified suppression strategy and metadata apply point.
  - Preserve plugin-contributed child behavior through plugin reload semantics.
  - This can run in parallel with Codex translation after the runtime config shape is available because the adapters are separate.
  - _Requirements: 3.1, 3.2, 5.1, 8.1, 9.1, 9.3, 12.2, 16.3_

- [x] 6.3 (P) Add Codex runtime translation and staging payload
  - Translate effective Codex skill and verified plugin state into the next-turn runtime config.
  - Keep SDK key assumptions isolated behind the translator.
  - Treat unresolved discovery or emission as a blocking verification failure for that cascade, not as a silent runtime success.
  - Ensure Codex never attempts live apply during an active turn.
  - This can run in parallel with Claude translation after the runtime config shape is available because the adapters are separate.
  - _Requirements: 8.2, 10.1, 10.2, 10.4, 12.2, 13.3_

- [x] 6.4 Track deterministic runtime hashes and apply records
  - Compute stable hashes for successfully emitted runtime capability config.
  - Store pending and applied hashes by cascade kind in conversation runtime state.
  - Preserve previous applied hashes when translation or apply fails.
  - Expose sanitized apply errors for UI diagnostics and retry.
  - _Requirements: 2.5, 8.4, 9.4, 9.5, 10.3, 14.2, 16.2, 16.3_

- [ ] 7. Apply capability changes to active conversations

- [x] 7.1 Apply or stage changes after override mutation
  - Fan out successful persisted changes to active conversations affected by the edited layer.
  - Apply live-applicable Claude changes immediately when the active conversation is idle.
  - Stage Codex changes for the next turn and never attempt mid-turn live updates.
  - Preserve overrides when apply fails and surface retryable diagnostics.
  - _Requirements: 6.3, 9.1, 9.3, 9.5, 10.1, 10.4, 14.3, 16.1, 16.2_

- [x] 7.2 Implement Claude idle-drain application
  - When a Claude turn is in flight, record staged-idle status without interrupting the turn.
  - Trigger pending apply as soon as the conversation transitions from running to idle.
  - Clear pending state only after the expected hash is successfully applied.
  - Add integration coverage for running to idle to applied, running to idle to failed, and retry.
  - _Requirements: 9.2, 9.4, 9.5, 15.1, 16.1_

- [x] 7.3 Apply staged capability config at turn start
  - Apply seeded conversation-start config when new Claude and Codex runtimes are created.
  - Promote Codex staged config to applied state at the start of the next turn.
  - Respect deferred-to-next-conversation statuses for unsupported live Claude paths.
  - Ensure active turns are never interrupted.
  - _Requirements: 8.1, 8.2, 9.3, 10.1, 10.2, 10.3, 10.4_

- [x] 7.4 Integrate apply fanout with diagnostics and retry status
  - Recompute affected active conversation config after a scope-level change.
  - Record planned disposition, success, failure, unsupported, and rejected outcomes.
  - Emit user-visible diagnostics and structured logs for each apply lifecycle event.
  - Keep failures scoped to affected cascade kinds.
  - _Requirements: 6.3, 8.3, 9.5, 13.3, 15.1, 16.1, 16.2, 16.3_

- [ ] 8. Expose API routes and synchronization

- [x] 8.1 Add capability view, patch, and refresh endpoints for every scope
  - Serve resolved views for global, project, session, and conversation layers.
  - Accept patch batches for the same scopes and validate them before mutation.
  - Support manual discovery refresh for the requested scope and cascade.
  - Return structured validation, not-found, conflict, persistence, and discovery errors.
  - _Requirements: 6.1, 6.4, 7.4, 13.1, 13.2, 14.3, 16.2_

- [x] 8.2 Add conflict-aware mutation responses
  - Return the latest view in conflict responses so clients can rebase.
  - Include enough scope and cascade information for callers to refresh the correct query.
  - Preserve all-or-nothing write behavior for every patch request.
  - Add integration tests for hash conflict, malformed patch body, persistence failure, and stale item write.
  - _Requirements: 6.2, 6.3, 13.1, 14.1, 14.3, 15.2, 15.3_

- [x] 8.3 Broadcast and consume capability update events
  - Broadcast successful override and discovery changes with scope, cascade, changed item ids, and effective hash hints.
  - Invalidate only affected capability queries on connected clients.
  - Ensure reconnect or missed event recovery refetches canonical state.
  - Add tests proving connected clients converge after sequential and conflicting edits.
  - _Requirements: 6.3, 15.1, 15.2, 15.3_

- [x] 9. Build the five capability panels

- [x] 9.1 Add query and mutation hooks for capability views
  - Fetch capability views by scope and cascade kind.
  - Toggle, reset, and refresh through schema-validated mutations.
  - Use optimistic updates only for visible pending state and roll back on error.
  - Invalidate queries from SSE events and mutation settlement.
  - _Requirements: 6.3, 7.4, 11.4, 12.3, 15.1_

- [x] 9.2 Build the shared panel experience for all five cascades
  - Render Claude Skills, Claude Plugins, Claude Sub-Agents, Codex Skills, and Codex Plugins as separate panels.
  - Show item name, source, backend, native default, effective state, origin layer, inherited-disable reason, stale status, pending status, and diagnostics.
  - Provide search and enabled, disabled, stale, and parent-disabled filters.
  - Provide layer switching that clearly distinguishes the edited layer from inherited broader-layer state.
  - _Requirements: 4.4, 5.2, 7.2, 7.3, 11.1, 11.2, 11.3, 11.4_

- [x] 9.3 Implement item controls and unavailable states
  - Provide binary toggles for enabled and disabled state plus a reset action for clearing the current-layer override.
  - Prevent one item edit from changing sibling, parent, unrelated layer, or unrelated cascade state.
  - Render stale rows as editable stored intent while showing that they are not runtime-emittable.
  - Render verification-gated Codex plugin rows with disabled item controls and clear diagnostics until support is verified.
  - Show applied, staged-idle, staged-next-turn, deferred-next-conversation, unsupported, rejected, and none statuses without UI-side backend branching.
  - _Requirements: 4.1, 4.2, 4.3, 5.2, 9.4, 10.3, 12.3, 13.2, 16.2_

- [x] 9.4 Add Storybook and UI regression coverage
  - Create stories for native, inherited, overridden, parent-disabled, stale, unavailable, pending, failed, and diagnostic states.
  - Test search, filters, layer switching, toggle, reset, refresh, and error rendering.
  - Verify text fits in compact panel rows and status badges across expected viewport sizes.
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 16.2_

- [ ] 10. Harden diagnostics, security, and reliability

- [x] 10.1 Add structured logging and user-visible diagnostics across the lifecycle
  - Log discovery, mutation, resolution, composition, apply, and SSE events with cascade, layer, item, backend, project, session, and conversation context when available.
  - Surface validation, discovery, persistence, composition, and apply failures to users with actionable messages.
  - Preserve correlation context so operators can trace one override from mutation through runtime apply.
  - _Requirements: 16.1, 16.2, 16.3_

- [x] 10.2 Add native-source redaction and read-only safeguards
  - Ensure native backend files are never written by this feature.
  - Redact plugin payloads, prompt bodies, environment values, tokens, and arbitrary native config contents from API responses, logs, and diagnostics.
  - Keep adapter-private native metadata available only to translators that need it for preservation behavior.
  - Add tests for redaction and no-write behavior.
  - _Requirements: 3.2, 7.2, 16.2, 16.3_

- [x] 10.3 Validate restart, cache, and scale behavior
  - Restore global and scoped overrides after process restart.
  - Confirm discovery cache invalidates on source signature changes and manual refresh.
  - Exercise large inventories with plugin-owned children to keep resolution deterministic and bounded.
  - Prove repeated identical runtime hashes are idempotent and do not trigger unnecessary apply work.
  - _Requirements: 2.5, 3.4, 7.4, 14.2, 15.3_

- [x] 10.4 Complete end-to-end acceptance validation
  - Run a full user flow from discovery through toggle, inheritance, plugin-forced disable, runtime composition, active apply or staging, SSE propagation, and UI refresh.
  - Verify Claude sessions ignore Codex cascades and Codex sessions ignore Claude cascades.
  - Verify conversation start remains non-blocking when one cascade has diagnostics.
  - Run typecheck, lint, and focused test suites needed for the feature before marking implementation complete.
  - _Requirements: 1.3, 1.4, 2.4, 5.1, 5.3, 6.3, 8.1, 8.2, 8.3, 9.1, 9.2, 10.1, 10.2, 15.1, 16.1_
