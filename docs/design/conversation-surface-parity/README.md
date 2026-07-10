# Conversation Surface Parity — Review & Unification Design

Status: decisions locked (Alex, 2026-07-09) — §5 is the approved parity set
Date: 2026-07-09

## 1. The four surfaces today

| # | Surface | Container chain | Transcript body | Composer |
|---|---------|----------------|-----------------|----------|
| S1 | Main conversation panel (`/conversations` workspace) | `ConversationWorkspace` → `SessionContent` → `ConversationPanelContainer` → `ConversationPanel` | `ConversationVirtuosoList` + `MessageRow`, rows via `useSessionPageConversation` | `PromptInputSlot` → `PromptComposer` |
| S2 | Split-screen panes (`/conversations`, layout=`panes`) | `SessionContent` → `PanesGrid` → `Pane` → `PaneConversationBody` | `ConversationVirtuosoList` + `MessageRow`, rows built inline | Shared pinned `PromptInputSlot` below the grid, targets the active pane |
| S3 | Project cockpit (project page) | `ProjectCockpit` → `ConversationPane` → `ProjectTranscriptHost` | **Raw `Virtuoso`** + `ConversationVirtuosoItem` + `MessageRow` (own row builder with spawn cards) | `UnifiedComposer` → `PromptComposer` |
| S4 | Workflow execution transcript | `GraphWorkflowPanel` → `WorkflowConversationViewer` → `ConversationPanel` (read-only) | `ConversationVirtuosoList` + `MessageRow` | none (by design) |

The rendering **leaves** (`MessageRow`, `MessageContent`, `TypingIndicator`, `ConversationVirtuosoList`) are already shared. What is duplicated 4× is the **container brain**: messages query → optimistic/queue projection → row building → indicator gating → scroll/follow state → empty/error states. Each copy trimmed different features, which is exactly where the discrepancies live.

## 2. Discrepancy matrix

Legend: ✓ works · ✗ missing · ◐ partial · n/a intentionally out of scope

| Behavior | S1 main | S2 panes | S3 cockpit | S4 workflow |
|---|---|---|---|---|
| Typing indicator (turn running) | ✓ `sending \|\| status==="running"`, collab-suppressed | ◐ active pane full; non-active `status` only (list-refetch latency); no collab suppression | ✓ hand-rolled `sender.sendingConversationId` | ✗ header "Live" badge only, no footer indicator |
| Optimistic echo of sent prompt | ✓ | ◐ active pane only (store is single-conversation) | ✗ waits for SSE append | n/a |
| Collab-mode UI (`CollabPassage`, pinned top) | ✓ | ✗ `renderCollab={() => null}`, envelope never passed (`PaneConversationBody.tsx:65,137`) | ✗ hardcoded `hasActiveCollab={false}` | ✗ renders null |
| Queued-message rows (`pendingQueue`) | ✓ | ✗ **even the active pane** — `useDisplayMessages(data, undefined, …)` (`PaneConversationBody.tsx:61`) | ✗ | n/a |
| Prompt error / cancelled banner | ✓ in-panel | ✗ toast only (`ConversationPanel` not mounted in panes) | ◐ composer-footer error | n/a |
| AskUserQuestion | ✓ interactive overlay | ◐ active pane via shared composer; non-active panes show a static amber text banner | ✗ | ◐ inspector-level panel (by design) |
| Alignment gate | ✓ | ✗ | n/a (session-scoped) | n/a |
| Fork | ✓ | ✗ | ✗ (no fork backend) | n/a (read-only) |
| Compact action / compaction affordances | ✓ | ✗ | ✗ | ✗ |
| Debug card (`lastMessageExtras`) | ✓ | ✗ | ✗ | n/a |
| Stop button | ✓ | ✗ | ✗ | n/a |
| Message nav (first/prev/next/last) | ✓ | ✗ (noop handlers) | ✗ | ✓ |
| Follow-bottom respects user scroll | ✓ tracked via `useConversationNav` | ✗ hardcoded `followBottom` → **auto-yank to bottom while reading history** | ✗ `followOutput` always smooth → same yank | ✓ |
| `worktreePath` (artifact/markdown cards resolve) | ✓ | ✗ `undefined` (`PaneConversationBody.tsx:132`) | ✗ | ✓ |
| Thinking-block expansion hotkeys | ✓ | ◐ active pane only (correct) | ✗ | ✗ |
| SSE: transcript updates | ✓ `message-appended` patches `conversationKeys.messages` | ✓ same cache key — works | ✓ project-scope handled in `NotificationListener` (the "not yet wired" comment in `project-conversations-client/query-keys.ts:7` is **stale**) | ✓ same cache key |
| SSE: status freshness | ✓ | ◐ via `conversationKeys.active()` list invalidate→refetch (one hop slower) | ✓ | ◐ derived from workflow-execution events |
| Empty/loading/error transcript states | "Loading conversation…" / EmptyState | bare text `Loading…` / `Could not load messages` | own variants | ConversationPanel's states |

Intentional visual variants to **keep**: per-surface chrome (pane header dot/title/close, cockpit worktree chip, workflow context/task/live header), pane density override (`.pane__body > .conversation`).

## 3. Root causes

1. **RC1 — duplicated container brain.** The transcript wiring is re-implemented per surface and each copy silently dropped features. New features (collab rows, queue rows, compaction) landed only in S1 because that's where they were developed.
2. **RC2 — single-conversation in-flight store.** `session-detail.store`'s optimistic slice (`sending`, `optimisticMessages`, `messageCountBeforeSubmit`, `optimisticQueue`, `promptError`, `promptCancelled`) is a page-global implicitly bound to "the conversation the composer targets". Every other surface must either opt out (`includeOptimistic: false` + all the leak-avoidance comments in `PaneConversationBody`/`use-display-messages`) or reinvent it (`ProjectCockpit`'s `sender.sendingConversationId`). This is the direct cause of "no loading indicator when a prompt is sent" in panes.
3. **RC3 — no SSE writer↔reader contract.** `NotificationListener` is the single write path, but nothing asserts each surface subscribes with the keys it patches. Symptom: the stale "not yet wired" comment + refetch-on-focus fallback in the project client that no longer reflects reality; the panes-typing-indicator regression shipped because no shared test covered indicator-on-SSE for that surface.

## 4. Design

### Phase 0 — conversation-keyed in-flight state (foundation)

Re-key the optimistic slice of `session-detail.store` by conversation id:

```ts
inFlightByConversation: Map<conversationId, {
  sending: boolean;
  optimisticMessages: TranscriptMessage[];
  messageCountBeforeSubmit: number;
  optimisticQueue: OptimisticQueueEntry[];
  promptError: string | null;
  promptCancelled: boolean;
}>
```

- Focused selectors per PERFORMANCE.md: `useSendingFor(conversationId)`, `useOptimisticMessagesFor(conversationId)`, …
- `use-send-prompt` writes under the target conversation id (it already knows it).
- Deletes: `includeOptimistic` option + the stable-empty-reference machinery in `use-display-messages`, the "leak" comments in `PaneConversationBody`, `ProjectCockpit`'s parallel `sendingConversationId` flag, `TypingIndicator`'s `hasAssistantOptimistic` override prop.
- Payoff: *every* surface can read its own conversation's in-flight state safely. Indicator correctness stops being a per-surface decision.

### Phase 1 — one `ConversationTranscript` component (core)

New `src/components/conversation/ConversationTranscript.tsx` — the single container brain, extracted from S1's wiring:

```ts
interface ConversationTranscriptProps {
  scope:
    | { kind: "session"; projectName: string; sessionName: string; conversationId: string }
    | { kind: "project"; projectName: string; conversationId: string };
  status: ConversationStatus;          // from the surface's list/detail source
  backend: AgentBackendId;
  pendingQueue?: readonly PendingQueuedMessage[];
  worktreePath?: string;
  capabilities?: {                      // default: all off (read-only)
    fork?: (messageIndex: number) => Promise<void>;
    compaction?: boolean;
    debugCard?: boolean;
    collab?: boolean;                   // session scope only
  };
  density?: "default" | "compact";     // pane density variant
  interleave?: TranscriptInterleave;    // spawn-card seam (project scope) — keeps the documented mount contract
  navHandle?: Ref<TranscriptNavHandle>; // first/prev/next/last + currentIndex for parent chrome
}
```

Internally it owns:
- scope-dispatched messages query (`useConversationMessagesQuery` vs `useProjectConversationMessagesQuery`) — same keys `NotificationListener` patches;
- display projection via `useDisplayMessages` with Phase-0 per-conversation optimistic state (no opt-out flag);
- row building: `buildConversationRows` + collab envelope (resolved internally from the collaboration list when `capabilities.collab`) + `interleave` extension rows;
- `TypingIndicator` footer with one gating rule: `sendingFor(id) || status === "running"`, collab-suppressed — identical everywhere;
- follow-bottom + range tracking (generalized `useConversationNav`) — fixes the auto-yank in S2/S3;
- unified loading/empty/error states;
- in-transcript prompt-error/cancelled banners fed from the per-conversation store slice (so panes finally surface failures in context).

Chrome (headers, stop button, context %, alignment gate, composer) stays **outside** in each surface's shell — that's the legitimate variation, expressed as normal composition rather than forked transcript logic.

### Phase 2 — adoption (one surface per commit)

| Surface | Change | Net effect |
|---|---|---|
| S1 | `ConversationPanelContainer` keeps `ConversationPanel` chrome, swaps body to `ConversationTranscript` | behavior-neutral refactor |
| S2 | `PaneConversationBody` collapses to `<ConversationTranscript scope=… density="compact" capabilities={{collab:true, fork, compaction:true}}>` | gains collab UI, queue rows, fork + compact actions, optimistic echo + reliable indicator, error banners, worktreePath, correct follow-bottom |
| S3 | `ProjectTranscriptHost` → `ConversationTranscript` with `scope:{kind:"project"}`, `interleave=spawnCards` | deletes the raw-Virtuoso duplicate; gains indicator/optimistic/scroll parity; collab stays off (unsupported in project scope) |
| S4 | `WorkflowConversationViewer` body → `ConversationTranscript` (no capabilities) | gains typing indicator while the implementer's conversation is running |

Then delete the superseded body code in all three non-S1 hosts.

### Phase 3 — SSE writer↔reader contract test

One jsdom suite mounting `ConversationTranscript` per scope against the existing `FakeEventSource` fixture (which already stamps envelopes like the real wire): fire `message-appended`, `message-updated`, `conversation-status` → assert the row appears and the indicator toggles. Because all four surfaces share the component, one suite covers the class of bug for every surface, permanently. Also: fix the stale comment + drop the refetch-on-focus fallback note in `project-conversations-client/query-keys.ts`/`queries.ts` if verified redundant.

## 5. Parity decisions (locked 2026-07-09)

| Decision | Verdict | Rationale |
|---|---|---|
| Collab UI in panes | **On** | core ask; envelope + renderer already exist, panes just never mounted them |
| Queue rows in panes | **On (all panes)** | `pendingQueue` is durable per-conversation server state — safe everywhere |
| Optimistic echo in panes | **On** (falls out of Phase 0) | keyed store removes the leak that forced it off |
| Interactive question panel in non-active panes | **Defer** — keep amber banner; clicking pane activates it, which retargets the shared composer + question panel | full per-pane panels change composer targeting semantics |
| Fork & compact in panes | **On** (Alex, doc feedback 2026-07-09) | each pane wires its own fork handler + compaction target through `capabilities` |
| Debug card in panes | **Off in v1** (capability flag exists, flipping later is one line) | tied to the active-conversation composer/debug loop |
| Fork / compact / debug in cockpit | **Off** | project conversations have no fork backend; compaction/debug not wired for project scope |
| Stop button in pane header | **On** (small, real value: stop a runaway pane without switching) | needs only the existing stop mutation + capability flag |
| Typing indicator in workflow viewer | **On when conversation running** | matches "Live" badge; zero extra data |
| Collab in project cockpit | **Stays off** | backend doesn't support collab in project scope |

## 6. Explicit non-goals

- Unifying the composer stacks (`PromptInputSlot` vs `UnifiedComposer`) — both already wrap `PromptComposer`; their divergence is scope semantics (queue-vs-send, slash commands), a separate effort.
- Making chrome identical across surfaces — headers intentionally differ.
- Interior changes to `MessageRow`/`MessageContent` — already shared.

## 7. Test strategy (TDD)

- Phase 0: unit tests on the keyed store slice (two conversations in flight; selectors isolate) before migrating writers.
- Phase 1: extract-and-pin — port S1's existing jsdom coverage to `ConversationTranscript` first (red on the new component), then adopt.
- Per adoption: the regression each surface previously had becomes a test (panes indicator on send; panes collab row; cockpit no-yank on scroll-up; workflow indicator while live).
- Phase 3 contract suite as described.
