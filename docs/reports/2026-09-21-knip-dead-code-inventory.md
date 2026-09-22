# Knip 6.37 upgrade and dead-code inventory

Date: 2026-09-21. Branch: `csm/dead-code-elimination-c1b7cc`.

Knip moved from 6.14.2 to 6.37.0 and the configuration was rewritten as
`knip.jsonc` for this repository. This report records what the new
configuration asserts about the project, the dead code the run identified, and
what the deletion pass on this branch removed. The inventory below is the
pre-deletion state; the "Deletion pass" section at the end says what was
deleted, what was kept, and why.

## Before and after

| Run                                | Unused files | Unused exports | Unused types | Dependency issues |
| ---------------------------------- | -----------: | -------------: | -----------: | ----------------: |
| Knip 6.14 with the old `knip.json` |           64 |            942 |        1 047 |                24 |
| Knip 6.37 with `knip.jsonc`        |           16 |            152 |          272 |                 0 |

The drop is not suppression. The old run counted design-tool exports, entry
files Knip could not discover (bun build targets, launchers started from shell
wrappers, child processes spawned by path), type companions of `.mjs` modules,
and exports that are still used inside their own file. Every remaining finding
was cross-checked by resolving the import specifiers of every file that mentions
the flagged name: none imports it from the flagged module. The apparent
exceptions are chains of unused re-exports (a barrel re-exports a symbol nobody
imports from the barrel either).

## What the configuration asserts

- Entry files: `src/cli/index.ts` and the Cursor worker `main.ts` (bun build
  targets, marked production with `!`), the Cursor acceptance child processes,
  the validation launchers in `scripts/validate/*.mjs`, the operator-run probes
  and spikes, `scripts/smart-merge-live-verify.ts`, and skill scripts under
  `.claude/skills/*/scripts/`.
- Ignored trees: `.design-sync/**` and `claude-design/**` (design-tool exports
  that `tsconfig.json` also excludes) and `scripts/validate/*.d.mts`.
- Ignored dependencies: the two Cursor platform packages (name derived at
  runtime), `@openai/codex` (version pin asserted by
  `app-server-version.arch.test.ts`), and `yalc` (resolved by path string).
- Ignored binaries: `cctl`, `agent`, `pgrep`, `ss`.
- `ignoreExportsUsedInFile: true`: an export that its own file still uses is a
  superfluous `export` keyword, not dead code. Flipping it off reports roughly
  1 500 such exports; `knip --fix --fix-type exports,types` can strip the
  keyword mechanically if that cleanup is wanted.

Six packages that source files import directly were transitive-only and are
now declared in `package.json`: `unified`, `remark-parse`, `unist-util-visit`,
`@annotorious/react` (pinned exactly to the version `@recogito/react-text-annotator`
resolves, so one copy stays installed), `@types/hast`, and
`@typescript-eslint/parser`.

Two scripts exist: `bun run knip` (default mode) and `bun run knip:production`
(ignores tests and stories; reports code only they reach).

## Dead code inventory

### A. Unused files (16)

Nothing imports these, including tests and stories. The commit is the one that
removed the last consumer, found with `git log -S`.

| File                                                            | Notes                                                                                                                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/test/storybook-setup.ts`                                   | Portable-stories helper; last consumer pruned in 92ed7d22d (2026-07-16). Its `@storybook/react` import is why the old `knip.json` carried an ignore entry.                                      |
| `src/hooks/use-file-autocomplete.ts`                            | Superseded by the unified reference picker in 348cd764d (2026-08-17). Part of the file-autocomplete cluster in section C.                                                                       |
| `src/cli/json-volume-exceptions.ts`                             | Its header says a contract test refuses stale entries; that test left with the cli-for-agents migration (42946e4cc, 2026-09-17). Either delete it or restore the test, since the list is inert. |
| `src/cli/commands/plan-review-advisory.ts`                      | Orphaned by 42946e4cc.                                                                                                                                                                          |
| `src/cli/commands/spec/plan-preview-text.ts`                    | Orphaned by 42946e4cc. It is the only non-test importer of `workflow-graph/launch-presentation.ts`, which then becomes production-dead too.                                                     |
| `src/lib/chat-spawning/query-keys.ts`                           | Orphaned in 884371eaf (2026-06-03).                                                                                                                                                             |
| `src/lib/prompt/queries.ts`, `src/lib/prompt/query-keys.ts`     | `export {}` and a one-key factory; orphaned in the 2026-05-24 reorganization.                                                                                                                   |
| `src/lib/sessions/lifecycle.ts`                                 | Re-export barrel over `sessions/service.ts` with no importer.                                                                                                                                   |
| `src/lib/workflow-graph/placement-normalization.ts`             | Authored in 6260d7bdb (2026-08-08) as the inflate boundary for pre-placement definitions and never wired into the read path. Confirm no stored definition still needs the backfill before deleting. |
| `src/features/config/sections/workflow/ClaudeAgentSubfields.tsx`, `CodexAgentSubfields.tsx` | Last consumer removed in d9221e1c0 (2026-08-05).                                                                                                                                                |
| `src/lib/agent-backends/testing/scripted-task-runners.ts`       | Test helper whose last test left with #155 (10db71d79, 2026-09-20).                                                                                                                             |
| `src/lib/agent-backends/codex/app-server-protocol-generated.ts` | Generated protocol subset nothing imports. `docs/design/codex-app-server/README.md` still lists it as used by `app-server-protocol.ts`; update the doc with the deletion.                        |
| `src/features/project-detail/spawn-card/spawn-card.css`         | Zero bytes. The CSS ratchet and the ESLint grandfather list point at `src/features/_root/spawn-card/spawn-card.css`, which no longer exists either; drop both entries with the file.               |
| `src/features/projects-index/styles/projects-index.css`         | Header comment only ("deleted at the end-state cleanup gate"); nothing imports it. Remove its entries in `scripts/css-migration-progress.ts` and `eslint.config.mjs`.                             |

### B. Unused exports and types (152 values, 272 types, 7 duplicates)

The full per-file list is in Appendix A. Grouped by what a deletion means:

1. **Barrel re-exports nobody imports.** `src/lib/prompt-editor/index.ts`
   (26 values, 36 types) is the largest; smaller chains sit in
   `specs/view-schemas.ts`, `specs/queries.ts`, `workflow-graph/schemas.ts`,
   `sessions/schemas.ts`, `workflows/collaboration/types.ts`,
   `workflow-graph/managed-definition-preflight.ts`, `managed-definition.ts`,
   `agent-backends/conversation-policy.ts`, `git/mutations.ts`
   (`ApiCallError`), `agent-gateway/route-handlers.ts` (the two header
   constants), `logging/index.ts`, and `conversations/service.ts`
   (`deriveSessionStatus`). Delete the re-export line; the source export may
   then show up as unused on the next run.
2. **React Query hooks and mutations with no caller.** `useGlobalAgentProfileLibrary`,
   `useGlobalAgentProfile`, `useNotepadGlobalListQuery`,
   `useReferenceDocumentContentQuery`, `useBranchPrefixQuery`, seven
   `useSpec*Query` hooks in `specs/queries.ts`,
   `useGraphWorkflowApprovalSnapshotQuery`, `useWorkflowDefinitionsQuery`, and
   the three workflow-definition mutations in `workflows/mutations.ts`. Five
   selector hooks in `stores/session-detail.store.ts` (`useOpenNotepadPanel`,
   `useQueueMessage`, `useFailOptimisticQueueEntry`,
   `useSetPendingTrayExpanded`, `useResetSessionDetailStore`).
3. **Service and engine functions with no caller.** The three actor factories
   in `workflows/merge/actors.ts` (lines 560, 819, 855),
   `launchGraphWorkflowExecution`, `approveGraphWorkflowDefinitionForSession`,
   and `findSessionPendingWorkflowDefinitionApproval` in
   `workflow-graph/production.ts`, `applyCostSettlementToHostedActor` and
   `hasLiveConversationActor` in `workflows/conversation/manager.ts`,
   `builder-draft.ts` `updateTask`/`removeTask`, `route-projection.ts`
   `outgoingRoutes`, `lane-identity.ts` `validateContextId`,
   `execution-origin.ts` `isOneOffExecution`, `spec-bridge.ts`
   `holdsExecutionLease`, the six exports of
   `workflows/primitives/structured-output-gate.ts`, `ref-parser.ts` (five
   finders), `sessions/service.ts` `sanitizeBranchName`, `dev-server/registry.ts`
   `stopAll`, `conversations/service.ts` `finalizeInitialization`,
   `tickets/list-cache.ts` `restoreTicketListCaches`,
   `specs/transitions.ts`, `specs/delivery-plan-diff.ts`,
   `specs/execution-service.ts` `parkBelongsToExecution`, `specs/lint.ts`
   `EVERGREEN_LINT_RULES`, `facet-gating.ts` `backendFacetRefusalIn`,
   `cursor/production-wiring.ts` `_resetCursorProductionTransportForTesting`,
   and the CLI helpers in `transport.ts` and `spec/projection-text.ts`.
4. **React components and hooks with no caller.** `AgentValidationEditor` and
   `LaneMergeValidationEditor` (`workflow-config/FieldEditors.tsx`),
   `PlacementEditor`, the two glyph icons in `InspectorChips.tsx`,
   `useClearEntering`, `incidentLabel`, `isCollabPassageTerminal`,
   `submitPeekReply`, `phaseTones`, `NOT_ANNOTATABLE_CLASS`,
   `STANDARD_AGENT_PROFILE_VALUE` in `AgentProfilePicker.tsx` (its consumers
   import the same name from `AgentProfileChoicePopover`), two fixture exports
   in `spec-studio/*.fixtures.ts`, and the `default` export of
   `SpecElementReader.tsx`.
5. **Zod schemas and `z.infer` types nobody imports.** About 250 of the 272
   types and most schema exports in `specs/schemas.ts`, `specs/view-schemas.ts`,
   `workflow-graph/schemas.ts`, `definition-schemas.ts`,
   `collaboration-schemas.ts`, `live-outline-schemas.ts`,
   `conversation-checkpoints/schemas.ts`, `memory/schemas.ts`,
   `notepads/schemas.ts`, `agent-backends/schemas.ts`, `api/sse-events.ts`,
   and the state-store repos. Mechanical deletions; the domain convention of
   exporting a type beside every schema is what produced most of them.
6. **Keep and tag `@public`.** The compound parts of the UI primitives
   (`ContextMenuPortal`, `ContextMenuGroup`, `ContextMenuRadioGroup`,
   `ContextMenuRadioItem`, `DropdownMenuPortal`, `DropdownMenuGroup`,
   `PopoverAnchor`, `TooltipPortal`) are the primitive's API surface. A
   `/** @public */` tag removes them from the report without a config entry.
7. **Duplicates (Appendix B).** Two named-plus-default pairs
   (`SpecElementReader`, `MessageTextWithRefs`): drop the default export. Five
   schema aliases where one constant is exported under two names: keep one, or
   tag the alias `@alias`.

### C. Code that only tests or stories reach (production mode)

`bun run knip:production` treats tests, stories, and fixtures as absent. Of the
220 files it reports, 186 are fixtures, harnesses, probes, and test helpers
that are test-only by design. The remaining 34 (Appendix C) are ordinary source
files with no production caller, and they cluster:

- **MCP configuration UI** (`src/components/mcp/`, nine components): reached
  only from stories and tests since ab9a54e65 (2026-08-22).
- **File autocomplete** (`FileAutocomplete.tsx`, `FileAutocompleteList.tsx`,
  `FileAutocompleteListView.tsx`, `lib/files/file-autocomplete-trigger.ts`,
  plus the hook in section A): replaced by the reference picker in 348cd764d.
- **Project-detail command console** (`CommandConsole.tsx`,
  `command-suggestions.ts`, `ComposerModeChip.tsx`, `ComposerSuggestions.tsx`):
  last production use removed in cafe3c1bd (2026-07-27) and 1cf7b6909
  (2026-06-09).
- **Workflow graph viewers** (`WorkflowDefinitionCanvas.tsx`,
  `WorkflowFinalizedLaunchMetadata.tsx`): detached in a1797d538 (2026-09-01);
  `workflow-config-panel/placeholder-screens.tsx` has only a test.
- **Singles:** `LoadingSessionView.tsx` (since 1de1a5ea2, 2026-06-12),
  `agent-backends/conformance.ts`, `agent-backends/index.ts`,
  `mcp/tool-discovery-invalidator.ts`, `mcp/tool-discovery-runtime.ts`,
  `shared/dom.ts`, `specs/approval-status.ts`,
  `workflow-graph/criterion-coverage.ts`, `workflow-graph/launch-presentation.ts`,
  `logging/trace-coverage.ts`, `cli/session-env-inventory.ts`.

Deleting a cluster means deleting its tests and stories with it. Whether a
cluster is dead or parked for future wiring is a product call; the history
above says which commit detached each one.

## Deletion pass

Everything in sections A and B was deleted except the eight UI primitive
parts, which carry `@public` tags, and two exports that Knip flagged but the
code still needs: `SettleTurnInput` and `FinalizeQueuedDeliveryInput` in
`workflows/conversation/types.ts` were referenced only through inline
`import("./types").X` type positions, which Knip does not follow. Those call
sites now use named type imports so the next run sees them. The merge-domain
parity guard `MergeHaltReasonSchemaParity` keeps its export with a `@public`
tag because the alias is what keeps the compile-time assertion alive, and
`structured-output-gate.ts` keeps re-exporting `validateOutputSchemaDeclaration`
with a `@public` tag because the output-schema architecture test requires the
gate to stay the server-side entry to the subset module.

Section C was deleted where the cluster was a detached feature: the MCP
configuration UI (nine components, four stories, one test, one fixture module),
the old file autocomplete (three components, the hook, the trigger detector,
and their stories and tests), the project-detail command console and composer
suggestions, the two workflow graph viewers, `LoadingSessionView`, the MCP
tool-discovery runtime and invalidator, `shared/dom.ts`,
`specs/approval-status.ts`, `workflow-graph/criterion-coverage.ts`,
`logging/trace-coverage.ts`, the `agent-backends/index.ts` barrel, and the
`graphWorkflowLaunchLabel` projection. Their tests and stories went with them.

Kept on purpose, because they are test infrastructure that guards production
code rather than dead features: `agent-backends/conformance.ts` (the backend
conformance suite), `cli/session-env-inventory.ts` (the session-env
classification table its architecture test enforces),
`workflow-config-panel/placeholder-screens.tsx` (the registry fixture for the
root-cards test), and `graphWorkflowLaunchExample` (the launch fixture two CLI
tests use). `bun run knip:production` still lists them, alongside the fixture
and testing modules that are test-only by design.

Ripple edits: the CSS ratchet and inventory scripts and the ESLint grandfather
list lost their entries for the two deleted stylesheets; the seam rule's
server-logging submodule set lost `trace-coverage`; the status-chip seam
ceiling dropped from 7 to 6 because `McpInfoChip` was one of the reviewed
survivors; `docs/design/codex-app-server/README.md` no longer names the
generated protocol file.

`bun run knip` exits 0 on the branch.

## Appendix A: unused exports and types (default mode)

Generated from `bun run knip --reporter json`. `E` = value exports, `T` = type exports; the number is the line.

```
scripts/probes/checkpoint-handoff/codex-faults.ts
  E codexToolViolationSourcePrompt:309
src/cli/commands/spec/projection-text.ts
  E reopenedApprovalLedgerLines:150, countOf:196
src/cli/transport.ts
  E issueDetailLines:246
src/components/agent-profiles/AgentProfilePicker.tsx
  E STANDARD_AGENT_PROFILE_VALUE:169
src/components/document-viewer/AnnotatedMarkdown.tsx
  E NOT_ANNOTATABLE_CLASS:18
  T AnnotatedMarkdownProps:15, ResolvedComment:17, ClipCaptureCapability:20, ClipSelectionContext:21, MarkdownAnchorState:23, MarkdownAnnotationTarget:25, MarkdownAnnotationTone:26, ResolvedMarkdownAnnotation:28, SpecThreadAnchorState:29
src/components/references/SpecRefChips.tsx
  T CopyReferenceControlDeps:719
src/components/session/prompt/PromptInputSlot.tsx
  T RefObject:119
src/components/session/sidebar/use-peek-reply.ts
  E submitPeekReply:124
src/components/ui/ContextMenu.tsx
  E ContextMenuPortal:75, ContextMenuGroup:76, ContextMenuRadioGroup:77, ContextMenuRadioItem:175
src/components/ui/DropdownMenu.tsx
  E DropdownMenuPortal:91, DropdownMenuGroup:92
src/components/ui/Popover.tsx
  E PopoverAnchor:92
src/components/ui/Tooltip.tsx
  E TooltipPortal:56
src/components/workflow-config/FieldEditors.tsx
  E AgentValidationEditor:591, LaneMergeValidationEditor:709
src/components/workflow-config/InspectorChips.tsx
  E SchemaGlyphIcon:101, EditGlyphIcon:117
src/components/workflow-config/PlacementEditor.tsx
  E PlacementEditor:76
src/features/project-detail/cockpit/use-cockpit-view-state.ts
  E useClearEntering:184
src/features/session-workflow/components/cohort-round-view.ts
  E incidentLabel:197
src/features/session/document-viewer/DocumentSurface.tsx
  T DocumentComment:467
src/features/session/hooks/use-collab-row-renderer.tsx
  E isCollabPassageTerminal:175
src/features/spec-studio/SpecAttentionRegister.tsx
  T SpecAttentionRegisterProps:2
src/features/spec-studio/SpecControls.fixtures.ts
  E policyImpactDraftFixture:39
src/features/spec-studio/SpecElementReader.tsx
  E default:1130
src/features/spec-studio/delivery-plan-review.fixtures.ts
  E previewView:145
src/features/spec-studio/presentation.ts
  E phaseTones:25
src/features/spec-studio/spec-comment-placement.ts
  T SpecCommentHostSurface:9
src/lib/active-conversations/schemas.ts
  T ActiveSpecExecutionItem:222
src/lib/agent-backends/catalog.ts
  T BackendSelectionDefaults:468
src/lib/agent-backends/conversation-policy.ts
  T BackendSelectionDefaults:40
src/lib/agent-backends/conversation.ts
  T ConversationBackgroundTaskView:49, EnsureReadyReason:219
src/lib/agent-backends/cursor/production-wiring.ts
  E _resetCursorProductionTransportForTesting:251
src/lib/agent-backends/facet-gating.ts
  E backendFacetRefusalIn:51
src/lib/agent-backends/runtime-config.ts
  T CapabilityOriginLayer:32
src/lib/agent-backends/schemas.ts
  T BackendModelParameterValue:44, BackendModelCatalogProvenance:91, ClaudeBackendConfig:370, CodexModelPricing:411, CursorBackendConfig:486, CodexConfig:500, CaptureUsage:567, CaptureActivity:577
src/lib/agent-gateway/route-handlers.ts
  E BUILD_MISMATCH_HEADER:27, CLI_BUILD_HEADER:27
src/lib/agent-profiles/queries.ts
  E useGlobalAgentProfileLibrary:92, useGlobalAgentProfile:132
src/lib/agent-runs/schemas.ts
  T AgentRunStatus:20, AgentRunOutput:59
src/lib/api/sse-events.ts
  T SpecRevisionChangedEvent:152, SpecApprovalChangedEvent:164, SpecExecutionChangedEvent:176, SpecEvidenceChangedEvent:190, SpecAttentionChangedEvent:202, SpecDeliveryPlanChangedEvent:215
src/lib/build-info/index.ts
  E buildInfoSchema:11
src/lib/commands/service.ts
  T FrontmatterResult:21
src/lib/context-artifacts/mutations.ts
  T CompactResponse:34
src/lib/context-artifacts/route-handlers.ts
  T CreateOrRefreshRequest:163
src/lib/context-artifacts/schemas.ts
  T ContextArtifactStatus:97
src/lib/conversation-checkpoints/mutations.ts
  T StartCheckpointResponse:47
src/lib/conversation-checkpoints/queries.ts
  T CheckpointSeed:79
src/lib/conversation-checkpoints/schemas.ts
  T CheckpointHandoffClaim:65, CheckpointTokenEstimate:483, CheckpointContextOccupancy:506, CheckpointProtectedReferences:523, CheckpointGeneratorVersions:717, CheckpointStructuredSections:739
src/lib/conversation-commands/schemas.ts
  T CommitMessageOutput:25
src/lib/conversations/group-content-blocks.ts
  E wholeMessagePart:112
src/lib/conversations/history-queries.ts
  T HistoryEntryMetadataResponse:32
src/lib/conversations/history-recovery.ts
  T TranscriptBoundary:268
src/lib/conversations/ref-parser.ts
  E findRefTags:19, findSpecRefs:38, findRequirementRefs:42, findDecisionRefs:46, findTaskRefs:50
src/lib/conversations/schemas.ts
  E toolResultMetricsSchema:48
  T NameOrigin:296, CreateSessionConversationRequest:530, ChangeConversationProfileRequest:533, ConversationCompactStatus:550
src/lib/conversations/service.ts
  E finalizeInitialization:961, deriveSessionStatus:968
src/lib/debug-log/schemas.ts
  T DebugHypothesis:16
src/lib/dev-server/registry.ts
  E stopAll:1178
src/lib/events/broadcaster.ts
  T BroadcastFn:7
src/lib/git/mutations.ts
  E ApiCallError:7
src/lib/jobs/schemas.ts
  T ResolutionInfrastructureHaltReason:84, JobsResponse:280
src/lib/logging/index.ts
  E isWithTracingWrapped:11, WITH_TRACING_MARKER:12
src/lib/memory/export.ts
  T MemoryArchiveLink:49
src/lib/memory/recall.ts
  T MemoryRankedCandidate:37, MemoryRankedRequest:39
src/lib/memory/schemas.ts
  T MemoryArtifactKind:250, MemorySessionIncarnation:304, MemoryReviewTarget:704, MemoryDeliveryPolicyOverride:910, MemoryDeliveryChannel:990, MemoryObservationKind:1080
src/lib/memory/testing/eval-corpus.ts
  T MemoryEvalCorpusNote:54, MemoryEvalCorpusQuery:73
src/lib/notepads/queries.ts
  E useNotepadGlobalListQuery:283
src/lib/notepads/schemas.ts
  T NotepadRevisionOrigin:34, CreateNotepadInput:349, NotepadContentWrite:402, RestoreNotepadRevisionInput:410, CreateNotepadCommentInput:426, ReplyToNotepadCommentInput:436, SetNotepadCommentStatusInput:451, NotepadCommentListQuery:459, NotepadListQuery:476
src/lib/notifications/schemas.ts
  T NotificationType:109
src/lib/project-conversations/schemas.ts
  T CreateProjectConversationRequest:14, ProjectFirstPromptRequest:34, ProjectConversationOpenRequest:41
src/lib/prompt-editor/index.ts
  E conversationRefAttrsToMentionAttrs:14, messageRefAttrsToMentionAttrs:19, ticketRefAttrsToMentionAttrs:24, notepadRefAttrsToMentionAttrs:29, buildSpecReadCommand:40, buildSpecReferenceXml:41, buildSpecSectionReadCommand:42, buildSpecSectionReferenceXml:43, specElementRefAttrsSchema:44, specElementRefAttrsToMentionAttrs:45, specRefAttrsSchema:46, specRefAttrsToMentionAttrs:47, specSectionRefAttrsSchema:48, specSectionRefAttrsToMentionAttrs:49, buildNotepadImageToken:66, findNotepadImageTokens:67, REFERENCE_PICKER_TRIGGERS:85, buildPickerView:92, parseSpecDrillInQuery:93, scopeForTrigger:95, PICKER_ELEMENT_ORDER:96, PICKER_KIND_ORDER:97, PICKER_SCOPE_CYCLE:98, PICKER_SECTION_CAP:99, getReferenceByNodeName:118, getReferenceByType:119, getReferenceByXmlTag:120
  T NotepadMentionAttrs:31, SpecElementRefAttrs:53, SpecRefAttrs:55, SpecReferenceType:56, SpecSectionMentionAttrs:57, SpecSectionRefAttrs:58, NotepadImageAttrs:62, NotepadImageNodeOptions:63, FoundNotepadImageToken:69, DeserializePromptDocOptions:75, AddImageResult:78, PastedImageNode:79, ReferencePickerExtensionOptions:88, ReferencePickerSuggestion:89, PickerDrillScope:102, PickerGlyph:103, PickerItemRow:104, PickerMoreRow:105, PickerRow:106, PickerScope:107, PickerSection:108, PickerTab:110, PickerView:112, PickerViewInput:113, ReferenceItemFact:123, ReferenceItemMeta:124, ReferenceItemPresentation:125, ReferenceNodeName:126, ReferencePickerContext:127, ReferencePickerItem:128, ReferencePickerSource:129, ReferenceRegistryEntry:130, ReferenceStatusTone:131, SpecPickerElement:132, SpecPickerSpec:133, ReferenceXmlTag:135
src/lib/prompt-editor/notepad-image-node.ts
  T NotepadImageAttrs:21
src/lib/prompt-editor/spec-mention-nodes.ts
  E buildSpecSectionReadCommand:11
  T SpecReferenceType:24, SpecSectionMentionAttrs:26
src/lib/push-notification/session-notification-route-handlers.ts
  T AgentNotificationBody:43
src/lib/reference-documents/queries.ts
  E useReferenceDocumentContentQuery:30
src/lib/session-alignment/schemas.ts
  T AlignmentVersionStatus:13, BeginDraftRequest:145, FillDraftRequest:158, ProposedDecision:179, SubmitCharterRequest:198, SubmitDecisionsRequest:208, DiffRequest:240
src/lib/sessions/list-schemas.ts
  T BranchPrefixResponse:61
src/lib/sessions/queries.ts
  E useBranchPrefixQuery:6
src/lib/sessions/schemas.ts
  E branchPrefixResponseSchema:20, derivedSessionStatusSchema:21, sessionsResponseSchema:24
  T BranchPrefixResponse:29
src/lib/sessions/service.ts
  E sanitizeBranchName:74
src/lib/shared/testing/element-at.ts
  E onlyElement:26
src/lib/specs/delivery-delta.ts
  T CriterionFreshnessGrade:56, DeliveryDeltaAdvisoryCode:124
src/lib/specs/delivery-plan-diff.ts
  E deliveryPlanDocumentDiff:10
src/lib/specs/delivery-plan-review.ts
  T DeliveryPlanReviewCriterion:21, DeliveryPlanReviewComment:37
src/lib/specs/delivery-plan-views.ts
  T DeliveryPlanHealthView:36, DeliveryPlanEditRequest:195
src/lib/specs/delivery-plan.ts
  E deliveryPlanEnvelopeByteLength:153
  T DeliveryPlanBindingDisposition:56, DeliveryPlanV4Document:164
src/lib/specs/execution-binding.ts
  T SpecExecutionBindingDisposition:23, SpecExecutionBindingClaim:39
src/lib/specs/execution-service.ts
  E parkBelongsToExecution:296
src/lib/specs/lint.ts
  E EVERGREEN_LINT_RULES:26
  T EvergreenLintRuleDefinition:27, EvergreenLintRuleId:28
src/lib/specs/measures.ts
  T TaskNavigation:251
src/lib/specs/phase.ts
  E authoringFacetSchema:23, specPhasePrimarySchema:25
  T AuthoringFacet:29, DeliveryCriterionState:49
src/lib/specs/proposal-notes.ts
  T ProposeEventPayload:39
src/lib/specs/queries.ts
  E specElementGetResponseSchema:26, specElementReferenceStateSchema:27, specElementViewSchema:28, specInventoryViewSchema:29, useSpecElementQuery:42, useSpecSummaryQuery:42, useSpecStatusQuery:301, useSpecPlanPreviewQuery:328, useSpecPlanDiffQuery:344, useSpecIntegrityQuery:361, useSpecSearchQuery:365
  T SpecAssumptionView:34, SpecElementReferenceState:36, SpecInventoryView:38, SpecQuestionView:39
src/lib/specs/reference-view-schemas.ts
  T SpecInventoryView:116, SpecQuestionElementView:180, SpecAssumptionElementView:193
src/lib/specs/schemas.ts
  T RequirementPriority:27, RequirementRisk:30, RejectedAlternative:123, TouchedPath:162, ExecutionLane:204, EvidenceEvaluatedState:299, HumanActorProvenance:317, ExternalDelivery:347, SpecReviewEventType:476, SpecInterventionEventType:487, SpecAuthoringEventType:494, SpecDeliveryPlanEventType:511, SpecImportEventType:522, SpecImportedEventPayload:553, SpecCitationContractVersion:588, SpecAttentionEditPayload:1051, SpecCommentResolution:1219, SpecProofVerdictKind:1226, SpecTaskClaimStatus:1239, SpecRow:1318, SpecAliasRow:1326, SpecCounterRow:1333, SpecElementRow:1343, SpecRevisionRow:1362, SpecRevisionSupersessionRow:1372, SpecElementVersionRow:1386, SpecAssumptionCitationRow:1524, SpecDeliveryBasis:1785, ImportBundleCriterion:2065, ImportBundleRequirement:2076, ImportBundleDecision:2089
src/lib/specs/transitions.ts
  E activeAuthoringStages:59, authoringStageIndex:60
src/lib/specs/view-schemas.ts
  E specAssumptionElementViewSchema:61, specElementReferenceStateSchema:64, specElementViewSchema:65, specQuestionElementViewSchema:66
  T SpecAssumptionElementView:71, SpecElementGetResponse:73, SpecElementReferenceState:74, SpecElementView:75, SpecQuestionElementView:76, SpecSummaryView:78, SpecRevisionElementView:94, RemainingAuthoringStage:415, SpecProposeApprovalRequestOutcome:474, SpecProposeResultView:520, SpecProjectSearchView:573, SpecSearchView:1223, SpecInventoryView:1228
src/lib/state-store/migrations/index.ts
  T MigrationContext:154
src/lib/state-store/store.ts
  T AllRepos:39
src/lib/state-store/tickets-repo.ts
  T AttachmentIdentity:75
src/lib/tickets/list-cache.ts
  E restoreTicketListCaches:25
src/lib/tickets/schemas.ts
  T TicketSessionStartMode:196, CreateTicketResponse:755, CreateTicketInput:776
src/lib/tickets/status-update-service.ts
  T ResolvedTicketStatusUpdateAuthor:314
src/lib/validation/api-schemas.ts
  T ValidationSubmitBody:54, ValidationPollQuery:125, ValidationListCommand:147, ValidationCapacity:155, ValidationActiveRun:171
src/lib/validation/schemas.ts
  T ValidationCommandName:17
src/lib/voice/schemas.ts
  T TranscribeResponse:16, VoiceHealthResponse:21
src/lib/workflow-graph/approval-snapshot-schemas.ts
  T GraphWorkflowApprovalSnapshot:22
src/lib/workflow-graph/authored-accountability-coverage.ts
  T AuthoredAccountabilityCoverageSource:13
src/lib/workflow-graph/builder-draft.ts
  E updateTask:430, removeTask:443
src/lib/workflow-graph/collaboration-schemas.ts
  T GraphWorkflowPendingCollaboration:176, CollaborationCrossReviewContent:435, CollaborationProposedChangesContent:467, CollaborationCounterProposalContent:499, CollaborationResolutionDecisionContent:555, CollaborationFinalAnswerContent:597
src/lib/workflow-graph/config-schemas.ts
  T GraphWorkflowHumanApprovalGateConfig:586
src/lib/workflow-graph/definition-schemas.ts
  T WorkflowOrigin:68, GraphWorkflowContextRoutingPolicy:122, OwnedPath:190, GraphWorkflowEdgeGuard:316, StringParameterDeclaration:398, TextParameterDeclaration:409, EnumParameterDeclaration:419, ResolvedMemoryDeliveryPolicy:588, GraphWorkflowCascadeLoopBodyTemplate:783, GraphWorkflowCascadeLoopGroup:791
src/lib/workflow-graph/event-schemas.ts
  T GraphWorkflowExecutionEventsResponse:1007
src/lib/workflow-graph/execution-origin.ts
  E isOneOffExecution:124
src/lib/workflow-graph/expansion-production.ts
  T GraphExpansionRequest:40
src/lib/workflow-graph/lane-identity.ts
  E validateContextId:270
src/lib/workflow-graph/launch-presentation.ts
  E graphWorkflowLaunchName:20
src/lib/workflow-graph/live-outline-schemas.ts
  T LiveOutlineImplementerSummary:173, LiveOutlineScriptValidatorSummary:204, LiveOutlineAgentValidationSummary:216, LiveOutlineCharter:669
src/lib/workflow-graph/managed-definition-preflight.ts
  E managedDefinitionPreflightFindingSchema:5, managedDefinitionPreflightRefusalCodeSchema:6, managedDefinitionPreflightRefusalSchema:7, managedDefinitionPreflightResultSchema:8, managedDefinitionPreflightSeveritySchema:9, managedDefinitionPreflightSummarySchema:11
  T ManagedDefinitionPreflightRefusal:13
src/lib/workflow-graph/managed-definition.ts
  E managedWorkflowDefinitionLifecycleSchema:7
  T ManagedWorkflowDefinitionLifecycle:10
src/lib/workflow-graph/plan-repair/supervisor.ts
  T PlanRepairSupervisor:928
src/lib/workflow-graph/production.ts
  E launchGraphWorkflowExecution:663, approveGraphWorkflowDefinitionForSession:718, findSessionPendingWorkflowDefinitionApproval:747
src/lib/workflow-graph/route-control-revision.ts
  T RouteControlRevisionBumpTrigger:31
src/lib/workflow-graph/route-projection.ts
  E outgoingRoutes:704
src/lib/workflow-graph/schemas.ts
  E graphWorkflowApprovalSnapshotResponseSchema:62, graphWorkflowApprovalSnapshotSchema:63, seededWorkflowDocumentSchema:2291
  T GraphWorkflowApprovalSnapshot:64, GraphWorkflowExecutionJoinConflictDetail:548, GraphWorkflowUserInputAnswers:774, GraphWorkflowRouteEdgeEvaluation:1205, GraphWorkflowLaneReservation:1338, GraphWorkflowAgentSessionTurnUsage:1464, GraphWorkflowLaunchStatus:1906, GraphWorkflowResultDeliveryState:2255, GraphWorkflowExecutionFullResponse:2350
src/lib/workflow-graph/spec-bridge.ts
  E holdsExecutionLease:21
  T GraphWorkflowSSEEvent:14
src/lib/workflow-graph/validator-runner.ts
  T IssueCriterionCitation:106
src/lib/workflows/charter-schemas.ts
  T SourceType:34
src/lib/workflows/collaboration/types.ts
  E collaborationGeneratedArtifactSchema:60, collaborationAgentModelSettingsSchema:287
  T CollaborationCounterProposalContent:46, CollaborationCrossReviewContent:50, CollaborationFinalAnswerContent:56, CollaborationGeneratedArtifactType:62, CollaborationProposedChangesContent:70, CollaborationResolutionDecisionContent:78
src/lib/workflows/conversation/manager.ts
  E applyCostSettlementToHostedActor:4086, hasLiveConversationActor:4120
src/lib/workflows/conversation/testing/checkpoint-harness.ts
  E throwingGenerator:246
src/lib/workflows/conversation/types.ts
  T SettleTurnInput:418
src/lib/workflows/edit-schemas.ts
  T WorkflowDefinitionEditRequest:396
src/lib/workflows/managed-definition-preflight-contract.ts
  T ManagedDefinitionPreflightRefusal:63
src/lib/workflows/merge/actors.ts
  E createPrepareActor:560, createPublishActor:819, createDiscardParkedRefActor:855
src/lib/workflows/merge/types.ts
  T MergeHaltReasonSchemaParity:123
src/lib/workflows/mutations.ts
  E useCreateWorkflowDefinitionMutation:71, useUpdateWorkflowDefinitionMutation:106, useDeleteWorkflowDefinitionMutation:133
src/lib/workflows/plan-review/schemas.ts
  T GraphPlanReviewVerdict:41
src/lib/workflows/plan-validation.ts
  E workflowPlanIssueSchema:33
src/lib/workflows/primitives/lane-vocabulary.ts
  T LaneTurnUsage:41, LaneMetrics:55
src/lib/workflows/primitives/structured-output-gate.ts
  E OUTPUT_SCHEMA_ANNOTATION_KEYWORDS:34, OUTPUT_SCHEMA_SUPPORTED_KEYWORDS:35, OUTPUT_SCHEMA_SUPPORTED_TYPES:36, UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS:37, outputSchemaKeywordGuidance:38, validateOutputSchemaDeclaration:40
  T OutputSchemaDeclarationIssue:41
src/lib/workflows/queries.ts
  E useGraphWorkflowApprovalSnapshotQuery:32, useWorkflowDefinitionsQuery:93
src/stores/session-detail.store.ts
  E useOpenNotepadPanel:134, useQueueMessage:157, useFailOptimisticQueueEntry:163, useSetPendingTrayExpanded:231, useResetSessionDetailStore:247
  T ConversationInFlight:15, OptimisticAgentSettings:16, SessionDetailState:17
```

## Appendix B: duplicate exports

```
src/lib/conversations/schemas.ts: storedConversationStateSchema:427 = conversationStateSchema:447
src/features/spec-studio/SpecElementReader.tsx: SpecElementReader:78 = default:1130
src/lib/workflows/charter-schemas.ts: charterScopeSchema:39 = charterInvariantAppliesToSchema:63
src/lib/workflow-graph/live-outline-schemas.ts: outputSchemaShapeSchema:32 = liveOutlineOutputSchemaSummarySchema:299
src/lib/tickets/relationship-service.ts: getTicketRelationshipServiceInputSchema:62 = removeTicketRelationshipServiceInputSchema:92
src/lib/specs/review-service.ts: signOffRevisionInputSchema:216 = approveRemainingAndSignOffInputSchema:227
src/features/session/conversation/MessageTextWithRefs.tsx: MessageTextWithRefs:67 = default:74
```

## Appendix C: files reachable only from tests or stories (production mode)

`bun run knip:production` reports 220 unused files. 170 of them are fixtures, harnesses, probes, or test helpers under `testing/`, `fixtures/`, `scripts/`, and similar paths, which are test-only by design. The 34 below are ordinary source files that no production entry reaches:

```
src/cli/session-env-inventory.ts
src/components/FileAutocomplete.tsx
src/components/FileAutocompleteList.tsx
src/components/FileAutocompleteListView.tsx
src/components/mcp/McpConfigButton.tsx
src/components/mcp/McpConfigPopover.tsx
src/components/mcp/McpGlobalSection.tsx
src/components/mcp/McpInfoChip.tsx
src/components/mcp/McpInheritBadge.tsx
src/components/mcp/McpServerCard.tsx
src/components/mcp/McpServerList.tsx
src/components/mcp/McpServersModal.tsx
src/components/mcp/McpToolRow.tsx
src/components/workflow-config-panel/placeholder-screens.tsx
src/components/workflow-graph/WorkflowDefinitionCanvas.tsx
src/components/workflow-graph/WorkflowFinalizedLaunchMetadata.tsx
src/lib/agent-backends/conformance.ts
src/lib/agent-backends/index.ts
src/lib/files/file-autocomplete-trigger.ts
src/lib/logging/trace-coverage.ts
src/lib/mcp/tool-discovery-invalidator.ts
src/lib/mcp/tool-discovery-runtime.ts
src/lib/shared/dom.ts
src/lib/specs/approval-status.ts
src/lib/workflow-graph/criterion-coverage.ts
src/lib/workflow-graph/launch-presentation.ts
src/features/project-detail/components/CommandConsole.tsx
src/features/project-detail/components/command-suggestions.ts
src/features/project-detail/composer/ComposerModeChip.tsx
src/features/project-detail/composer/ComposerSuggestions.tsx
src/features/session/conversation/LoadingSessionView.tsx
src/lib/agent-backends/cursor/model-catalog-generation.ts
src/lib/logging/log-analysis/cli.ts
src/lib/logging/log-analysis/markdown.ts
```
