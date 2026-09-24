/**
 * The executable Cursor parity acceptance matrix (ticket command-center#125).
 *
 * The parity question has been answered in prose twice — once by the
 * 2026-09-04 audit and once per child ticket — and prose cannot fail. This
 * module is the answer in a form that can: every row names the live capability
 * facts it rests on, the audit gap it closes, the ticket that owns it, and the
 * evidence that proves it. The sibling test refuses any row whose facts have
 * drifted from the registered descriptor, whose evidence no longer exists, or
 * whose audit gap nobody claims.
 */

import { cursorMcpCapabilities } from "@/lib/agent-backends/cursor/mcp-capabilities";
import {
  cursorConversationCapabilities,
  cursorConversationExecution,
  cursorConversationFsWriteRestriction,
  cursorManagedSkills,
  cursorNativeMemory,
  cursorTaskExecution,
  cursorTaskFsWriteRestriction,
  cursorTaskStructuredOutput,
} from "../descriptor";

/**
 * The application areas the final validation has to cover. Taken from the
 * ticket's live-flow list rather than from the shape of the implementation, so
 * an area cannot disappear from the matrix by being deleted from the code.
 */
export const CURSOR_PARITY_AREAS = [
  "runtime",
  "conversation",
  "continuity",
  "interaction",
  "capabilities",
  "mcp",
  "tasks",
  "assistance",
  "workflows",
  "collaboration",
  "observability",
  "policy",
] as const;

export type CursorParityArea = (typeof CURSOR_PARITY_AREAS)[number];

/** Ticket #59 delivered the Phase 1 backend; #111–#124 are #125's dependencies. */
export const CURSOR_PARITY_OWNERS = [
  "command-center#59",
  "command-center#111",
  "command-center#112",
  "command-center#113",
  "command-center#114",
  "command-center#115",
  "command-center#116",
  "command-center#117",
  "command-center#118",
  "command-center#119",
  "command-center#120",
  "command-center#121",
  "command-center#122",
  "command-center#123",
  "command-center#124",
] as const;

export type CursorParityOwner = (typeof CURSOR_PARITY_OWNERS)[number];

/**
 * How Cursor delivers the row's behavior.
 *
 * The distinction that matters is the last two. `instruction-only` means Command
 * Center asks the agent to observe a limit it cannot enforce; `unavailable`
 * means no supported mechanism exists and the value stays unknown rather than
 * being approximated. Neither may be described as a guarantee.
 */
export type CursorParityMechanism =
  | "native"
  | "cc-owned"
  | "instruction-only"
  | "unavailable";

export type CursorParityVerdict = "verified" | "unresolved";

export type CursorParityEvidence =
  | { readonly kind: "test"; readonly file: string }
  | { readonly kind: "report"; readonly file: string }
  | {
      readonly kind: "acceptance-case";
      readonly file: string;
      readonly caseId: string;
    };

export interface CursorParityRow {
  readonly id: string;
  readonly area: CursorParityArea;
  readonly claim: string;
  readonly mechanism: CursorParityMechanism;
  /** What is weaker than the Claude equivalent, or null when nothing is. */
  readonly limitation: string | null;
  readonly owner: CursorParityOwner;
  readonly verdict: CursorParityVerdict;
  /** What stops the row from passing. Null exactly when the verdict is a pass. */
  readonly blocker: string | null;
  /**
   * True when the row describes behavior a user drives through the running
   * application, which a unit test alone cannot establish.
   */
  readonly liveFlow: boolean;
  readonly facts: readonly string[];
  readonly auditGaps: readonly string[];
  readonly evidence: readonly CursorParityEvidence[];
}

/**
 * Every gap the 2026-09-04 audit recorded, as an id the matrix must claim.
 *
 * The audit is the agreed enumeration of what was missing, so closing it is
 * how "every audit gap is accounted for" becomes checkable instead of
 * asserted. The ids are stable; the labels are the audit's own wording.
 */
export const CURSOR_AUDIT_BASELINE_GAPS: Readonly<Record<string, string>> = {
  "comparison-queue": "Submit another message while running",
  "comparison-fork": "Conversation fork continuity",
  "comparison-task-facet": "One-shot task execution",
  "comparison-structured-output": "Structured final output",
  "comparison-context-metrics": "Context-window occupancy/max metrics",
  "comparison-native-questions": "Native mid-turn question handling",
  "comparison-external-turns": "Provider-originated external turns",
  "comparison-managed-skills": "CC managed skill bundle",
  "comparison-capability-kinds": "User capability cascade",
  "comparison-fs-write": "Exact filesystem write restrictions",
  "comparison-native-memory": "CC neutralizes provider-native memory",
  "comparison-mcp-transports": "MCP transports",
  "comparison-mcp-filtering": "MCP per-tool filtering",
  "comparison-mcp-authority": "MCP authoritative config guarantee",
  "comparison-cost": "Cost accounting",
  "feature-workflow-assignments":
    "Graph workflow implementer, validator, advisory and repair assignments",
  "feature-auxiliary-runners":
    "Planner, validator, output capture, advisory response and plan repair execution",
  "feature-owned-workflow-writes": "Ownership-confined workflow work",
  "feature-spec-delivery": "Native spec managed delivery",
  "feature-collaboration": "Collaboration Mode and /collab",
  "feature-agent-run-cli": "cctl agent run with Cursor",
  "feature-ticket-command": "/ticket from conversation context",
  "feature-quick-ticket-enrichment": "Quick Ticket enrichment",
  "feature-commit-merge-message": "/commit and /merge generated message",
  "feature-validation-fix": "Smart Commit/Merge validation fixes",
  "feature-conflict-resolution": "Conflict analysis/resolution",
  "feature-compaction": "Compaction generation",
  "feature-conversation-naming": "Conversation naming",
  "feature-session-naming": "Session name generation",
  "feature-queue": "Queueing while Cursor works",
  "feature-fork": "Context-preserving conversation forks",
  "feature-background-activity":
    "Background activity and automatic continuation",
  "feature-context-thresholds":
    "Context thresholds and native compaction reporting",
  "feature-managed-skills": "Managed skills and capability settings",
  "feature-command-availability":
    "Built-in command availability reflects actual execution requirements",
  "feature-mcp-controls": "MCP controls",
  "feature-shared-memory": "Shared-memory exclusivity",
  "defect-1-mcp-patch-backend":
    "Conversation MCP PATCH selects the wrong backend",
  "defect-2-fork-disclosure":
    "Fork UI can imply continuity that does not exist",
  "defect-3-continuity-binding":
    "Production continuity probes are deliberately unbound",
  "defect-4-task-profile-gating":
    "A task-facet boolean is too broad for staged rollout",
  "defect-5-fs-policy-refusal":
    "Provider policy is weaker than the neutral input shape",
};

const FINAL_REPORT =
  "docs/reports/2026-09-21-cursor-parity-final-validation.md";
const ACCEPTANCE = "src/lib/agent-backends/cursor/acceptance";

function test(file: string): CursorParityEvidence {
  return { kind: "test", file };
}

function report(file: string): CursorParityEvidence {
  return { kind: "report", file };
}

function live(file: string, caseId: string): CursorParityEvidence {
  return { kind: "acceptance-case", file: `${ACCEPTANCE}/${file}`, caseId };
}

/** The authenticated application pass this ticket performed. Cited by every row
 *  whose behavior only exists once a real turn has run. */
const APPLICATION_PASS = report(FINAL_REPORT);

export const CURSOR_PARITY_MATRIX: readonly CursorParityRow[] = [
  // ----- runtime ---------------------------------------------------------
  {
    id: "authenticated-launch",
    area: "runtime",
    claim:
      "A worker authenticates with the explicitly supplied API key. An absent or rejected credential fails preflight with a named reason instead of starting a degraded run.",
    mechanism: "native",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/preflight.test.ts"),
      live("harness.acceptance.test.ts", "credential-live"),
      live("preflight.acceptance.test.ts", "preflight-credential-absent"),
      live("preflight.acceptance.test.ts", "preflight-credential-invalid"),
      live("preflight.acceptance.test.ts", "preflight-credential-valid"),
      live("preflight.acceptance.test.ts", "preflight-cli-is-not-sdk-auth"),
    ],
  },
  {
    id: "pinned-baseline",
    area: "runtime",
    claim:
      "The SDK and its platform-native package are pinned together and checked against the host before a turn, so a mismatched install refuses rather than failing mid-run.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/sdk-pin.test.ts"),
      live("harness.acceptance.test.ts", "baseline"),
    ],
  },
  {
    id: "credential-isolation",
    area: "runtime",
    claim:
      "The worker and every process it spawns carry no credential in argv or environment, and the SDK writes no agent state outside the store Command Center owns.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/worker/credential-env.test.ts"),
      live("isolation.acceptance.test.ts", "worker-group-argv-env-scan"),
      live("isolation.acceptance.test.ts", "worker-concurrency-isolation"),
      live(
        "final-credential-scan.acceptance.test.ts",
        "final-credential-sweep",
      ),
    ],
  },
  {
    id: "worker-lifetime",
    area: "runtime",
    claim:
      "Workers are supervised: an orphaned worker exits with its parent and an idle worker expires, so a conversation left alone reclaims its process.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/worker/supervisor.test.ts"),
      live("lifetime.acceptance.test.ts", "orphan-worker-lifetime"),
      live("lifetime.acceptance.test.ts", "idle-worker-expiry"),
    ],
  },
  {
    id: "cancellation",
    area: "runtime",
    claim:
      "Cancelling a turn stops generation, a running shell descendant and a blocked MCP call, and leaves no marked process on the host.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/conversation-runtime.test.ts"),
      live("cancellation.acceptance.test.ts", "cancel-generation"),
      live(
        "cancellation.acceptance.test.ts",
        "cancel-shell-descendant-trial-1",
      ),
      live("mcp.acceptance.test.ts", "cancel-long-mcp-call"),
      live("cancellation.acceptance.test.ts", "cancel-usage-attribution"),
    ],
  },

  // ----- conversation ----------------------------------------------------
  {
    id: "session-project-chat",
    area: "conversation",
    claim:
      "Session-scoped and project-scoped conversations stream text, thinking and tool activity from Cursor and persist every native envelope as a durable transcript.",
    mechanism: "native",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/transcript-projections.test.ts"),
      test(
        "src/lib/agent-backends/cursor/conversation-runtime.behavior.test.ts",
      ),
      live("streaming.acceptance.test.ts", "streaming-ordinary-turn"),
      live("file-operations.acceptance.test.ts", "streaming-file-operations"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "image-input",
    area: "conversation",
    claim:
      "PNG, JPEG, WebP and GIF attachments reach the model, bounded at five images, 5 MiB decoded per image and 20 MiB per turn.",
    mechanism: "native",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/image-input.test.ts"),
      live("image.acceptance.test.ts", "image-turn"),
    ],
  },
  {
    id: "model-catalog",
    area: "conversation",
    claim:
      "Models come from a generated catalog minus the project's opt-out list, with parameters and variants carried through the shared model-selection contract; a model the provider rejects surfaces that rejection.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/model-catalog.test.ts"),
      test("src/lib/agent-backends/cursor/model-policy.test.ts"),
      test("src/lib/agent-backends/cursor/model-config.integration.test.ts"),
      live("models.acceptance.test.ts", "model-available-custom"),
      live("models.acceptance.test.ts", "model-applied-on-resume"),
      live("models.acceptance.test.ts", "model-sdk-rejected"),
    ],
  },
  {
    id: "structured-output",
    area: "conversation",
    claim:
      "Conversations and tasks satisfy the shared structured-output contract by rendering it into the prompt and validating the answer afterwards.",
    mechanism: "cc-owned",
    limitation:
      "No native output schema is forwarded to the provider, so a malformed answer is caught after the turn rather than prevented during it.",
    owner: "command-center#115",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [
      "conversation.capabilities.structuredOutput",
      "tasks.structuredOutput",
    ],
    auditGaps: ["comparison-structured-output"],
    evidence: [
      test("src/lib/agent-backends/structured-output.test.ts"),
      test("src/lib/agent-backends/cursor/task-runner.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- continuity ------------------------------------------------------
  {
    id: "conversation-resume",
    area: "continuity",
    claim:
      "A Cursor agent id is a real provider handle, so resume returns to that exact session rather than replaying a reconstructed thread.",
    mechanism: "native",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["conversation.capabilities.continuationStrength"],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/continuity.test.ts"),
      live("continuation.acceptance.test.ts", "continuation-restart"),
      live("continuation.acceptance.test.ts", "continuation-invalid-refs"),
    ],
  },
  {
    id: "restart-durability",
    area: "continuity",
    claim:
      "A server restart reloads the backend and its opaque provider reference from SQLite, and the next prompt resumes the same Cursor agent.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#59",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/conversations/cursor-backend-restart.durability.test.ts"),
      live("continuation.acceptance.test.ts", "continuation-restart"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "durable-queue",
    area: "continuity",
    claim:
      "A message submitted while Cursor is working is stored in SQLite and drained exactly once, preserving its model choice and images across cancellation and server restart.",
    mechanism: "cc-owned",
    limitation:
      "Recovery after an ambiguous dispatch holds the message for review instead of replaying it, because the provider offers no delivery idempotency key.",
    owner: "command-center#112",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["conversation.capabilities.queue.acceptsWhileRunning"],
    auditGaps: ["comparison-queue", "feature-queue"],
    evidence: [
      test("src/lib/conversations/message-queue-service.test.ts"),
      test("src/lib/conversations/message-queue-recovery.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "synthetic-fork",
    area: "continuity",
    claim:
      "A fork seeds an independent agent and store with bounded transcript text, and the UI labels that seed as synthetic rather than as inherited model context.",
    mechanism: "cc-owned",
    limitation:
      "Provider checkpoints and hidden state are not inherited, so a fork resumes from the visible transcript rather than from the source agent's internal state.",
    owner: "command-center#112",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["conversation.capabilities.fork"],
    auditGaps: ["comparison-fork", "feature-fork", "defect-2-fork-disclosure"],
    evidence: [
      test("src/lib/sessions/synthetic-fork-seed.test.ts"),
      test("src/lib/conversations/service.test.ts"),
      test("src/lib/agent-backends/cursor/continuity.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "checkpoint-capture",
    area: "continuity",
    claim:
      "Command Center declares checkpoint capture, checkpoint forks and agent handoff unavailable for Cursor, so those actions are withheld rather than offered and then failing.",
    mechanism: "unavailable",
    limitation:
      "Cursor conversations cannot produce a Command Center checkpoint, a checkpoint fork or a handoff summary; history zoom and checkpoint-based recovery stay Claude and Codex features.",
    owner: "command-center#111",
    verdict: "verified",
    blocker: null,
    liveFlow: false,
    facts: [
      "conversation.capabilities.checkpoint",
      "conversation.capabilities.checkpointFork",
      "conversation.capabilities.handoffCapture.available",
      "conversation.capabilities.handoffCapture.mode",
      "conversation.capabilities.handoffCapture.reason",
    ],
    auditGaps: [],
    evidence: [
      test("src/lib/conversation-checkpoints/fork-capabilities.test.ts"),
      test("src/lib/agent-backends/cursor/descriptor.test.ts"),
    ],
  },

  // ----- interaction -----------------------------------------------------
  {
    id: "in-turn-steering",
    area: "interaction",
    claim:
      "Text submitted during a running turn is steered into that turn through the provider's steer API, with the acknowledgement correlated to the requesting run.",
    mechanism: "native",
    limitation:
      "Attachments and provider refusals fall back to the next turn, and an acknowledgement lost after dispatch leaves delivery uncertain for review rather than resending.",
    owner: "command-center#123",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["conversation.capabilities.queue.deliveryTiming"],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/steering.test.ts"),
      report("docs/reports/2026-09-15-cursor-interactions.md"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "cc-questions",
    area: "interaction",
    claim:
      "Cursor asks the user a mid-turn question through Command Center's own question tool over the SDK's supported custom-tool callback, using the existing question panel.",
    mechanism: "cc-owned",
    limitation:
      "A question expires after five minutes, only one batch is pending per conversation, and a restarted server cannot reconnect an outstanding callback, so its marker is retired and a late reply is refused.",
    owner: "command-center#123",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/conversations/in-turn-questions.test.ts"),
      test("src/lib/agent-backends/cursor/worker/question-bridge.test.ts"),
      report("docs/reports/2026-09-15-cursor-interactions.md"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "native-question-api",
    area: "interaction",
    claim:
      "The provider's own interactive request tools stay denied, and the descriptor declares no native mid-turn ask.",
    mechanism: "unavailable",
    limitation:
      "Command Center's question tool is a substitute over a supported callback, not the provider's native question API, so it cannot survive a process restart the way a provider-held request could.",
    owner: "command-center#123",
    verdict: "unresolved",
    blocker:
      "The installed SDK rejects native questions in both main-loop and subagent execution, so no provider-held interactive request exists to bind to.",
    liveFlow: false,
    facts: ["conversation.capabilities.nativeMidTurnAskUser"],
    auditGaps: ["comparison-native-questions"],
    evidence: [
      test("src/lib/agent-backends/cursor/policy.test.ts"),
      report("docs/reports/2026-09-15-cursor-interactions.md"),
    ],
  },
  {
    id: "background-tasks",
    area: "interaction",
    claim:
      "Native subagent task calls are tracked in a durable per-conversation store and published as live background activity; tasks still running when the turn ends are marked lost and disclosed to the next turn.",
    mechanism: "cc-owned",
    limitation:
      "Tracking ends with the turn: an unfinished task is reported as lost rather than continued, and live activity is rebuilt from the store rather than restored after a restart.",
    owner: "command-center#122",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-background-activity"],
    evidence: [
      test("src/lib/agent-backends/cursor/background-tasks.test.ts"),
      test("src/lib/agent-backends/cursor/background-task-store.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "provider-external-turns",
    area: "interaction",
    claim:
      "Cursor produces no turns Command Center did not start, and the descriptor declares external turns unavailable rather than simulating them.",
    mechanism: "unavailable",
    limitation:
      "Work that finishes after a turn ends cannot wake the conversation, so an agent is instructed to complete background work inside its turn instead of relying on a continuation.",
    owner: "command-center#122",
    verdict: "unresolved",
    blocker:
      "The SDK offers no completion subscription once a run has ended, so there is no supported signal to start a provider-originated turn from.",
    liveFlow: false,
    facts: ["conversation.capabilities.externalTurns"],
    auditGaps: ["comparison-external-turns"],
    evidence: [test("src/lib/agent-backends/cursor/descriptor.test.ts")],
  },

  // ----- capabilities ----------------------------------------------------
  {
    id: "managed-skill-bundle",
    area: "capabilities",
    claim:
      "Command Center's immutable managed skill bundle reaches Cursor conversations and tasks, alongside project and user skills discovered from disk, while ambient provider settings stay suppressed.",
    mechanism: "cc-owned",
    limitation:
      "Skills are delivered as a rendered catalog in the session instructions rather than as provider-native skill objects, and the catalog is capped at 16 KiB.",
    owner: "command-center#113",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["managedSkills.conversations", "managedSkills.tasks"],
    auditGaps: ["comparison-managed-skills", "feature-managed-skills"],
    evidence: [
      test("src/lib/agent-backends/cursor/capability-delivery.test.ts"),
      test("src/lib/agent-backends/cursor/capability-catalog.test.ts"),
      test("src/lib/managed-skills/service.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "capability-cascade",
    area: "capabilities",
    claim:
      "Skills, plugins and agents resolve through the shared cascade and are applied when the next conversation starts.",
    mechanism: "cc-owned",
    limitation:
      "Capability selection is fixed when a conversation is created, so a change made mid-conversation is deferred rather than applied live; plugin rules, hooks and commands are not translated.",
    owner: "command-center#113",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["conversation.capabilities.capabilityKinds"],
    auditGaps: ["comparison-capability-kinds"],
    evidence: [
      test("src/lib/agent-backends/cursor/runtime-config.test.ts"),
      test("src/lib/agent-capabilities/cursor-runtime-state.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "command-catalog",
    area: "capabilities",
    claim:
      "The command palette lists the built-in commands Cursor can actually execute, and skill-derived commands share its slash prefix.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#113",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-command-availability"],
    evidence: [
      test("src/lib/commands/backend-command-catalog.test.ts"),
      test("src/lib/commands/capability-filter.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- mcp -------------------------------------------------------------
  {
    id: "mcp-transports",
    area: "mcp",
    claim:
      "stdio, streamable HTTP and SSE servers all reach a Cursor turn through the worker's MCP bridge.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#114",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [
      "mcp.transports.stdio",
      "mcp.transports.streamable-http",
      "mcp.transports.sse",
    ],
    auditGaps: ["comparison-mcp-transports"],
    evidence: [
      test("src/lib/agent-backends/cursor/mcp-translation.test.ts"),
      test("src/lib/mcp/backend-capabilities.test.ts"),
      live("mcp-parity.acceptance.test.ts", "mcp-parity-transports"),
      live("mcp.acceptance.test.ts", "mcp-inline-stdio"),
    ],
  },
  {
    id: "mcp-tool-filtering",
    area: "mcp",
    claim:
      "Per-tool allow and deny lists are enforced by Command Center's bridge in front of every transport, so a filtered tool is never reachable from the agent.",
    mechanism: "cc-owned",
    limitation:
      "Filtering is a Command Center bridge rather than a provider-native permission layer, so it covers the tools the bridge exposes rather than being enforced inside the provider.",
    owner: "command-center#114",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [
      "mcp.toolFiltering.mode",
      "mcp.toolFiltering.byTransport.stdio",
      "mcp.toolFiltering.byTransport.streamable-http",
      "mcp.toolFiltering.byTransport.sse",
    ],
    auditGaps: ["comparison-mcp-filtering"],
    evidence: [
      test("src/lib/agent-backends/cursor/worker/mcp-bridge.test.ts"),
      live("mcp-parity.acceptance.test.ts", "mcp-parity-transports"),
    ],
  },
  {
    id: "mcp-inventory",
    area: "mcp",
    claim:
      "Tool inventory comes from a direct probe, and configured startup and per-tool deadlines are enforced by the bridge.",
    mechanism: "cc-owned",
    limitation:
      "There is no provider runtime-status query, so the inventory reflects a probe Command Center performed rather than the server list the provider currently holds.",
    owner: "command-center#114",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["mcp.toolDiscovery.preferred", "mcp.toolDiscovery.probeFallback"],
    auditGaps: ["feature-mcp-controls"],
    evidence: [
      test("src/lib/mcp/tool-discovery-probe.test.ts"),
      test("src/lib/agent-backends/cursor/worker/mcp-bridge.test.ts"),
      report(FINAL_REPORT),
    ],
  },
  {
    id: "mcp-apply",
    area: "mcp",
    claim:
      "A disabled server is omitted from the emitted configuration, and a configuration change takes effect on the next turn.",
    mechanism: "cc-owned",
    limitation: "Saved changes apply when the next input is accepted.",
    owner: "command-center#114",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["mcp.serverDisable", "mcp.betweenTurnApply"],
    auditGaps: [],
    evidence: [test("src/lib/mcp/runtime-apply.test.ts"), APPLICATION_PASS],
  },
  {
    id: "mcp-config-authority",
    area: "mcp",
    claim:
      "Command Center supplies MCP servers inline with ambient setting sources suppressed, and declares that it is not the authoritative configuration.",
    mechanism: "unavailable",
    limitation:
      "Provider-side administrative MCP configuration is outside Command Center's resolved set, so the configuration a user sees is what Command Center supplied, not necessarily everything the agent can reach.",
    owner: "command-center#114",
    verdict: "unresolved",
    blocker:
      "The provider exposes no way to read or override account-level MCP administration, so authoritative configuration cannot be declared without overclaiming.",
    liveFlow: false,
    facts: ["mcp.strictAuthoritativeConfig", "mcp.notes"],
    auditGaps: ["comparison-mcp-authority"],
    evidence: [test("src/lib/mcp/backend-capabilities.test.ts")],
  },
  {
    id: "mcp-conversation-override",
    area: "mcp",
    claim:
      "Patching MCP configuration on a conversation reads that conversation's own backend, so a Cursor conversation is applied with Cursor's timing rather than Claude's.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#114",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["defect-1-mcp-patch-backend"],
    evidence: [
      test("src/lib/mcp/config-route-handlers.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- tasks -----------------------------------------------------------
  {
    id: "task-runner",
    area: "tasks",
    claim:
      "Cursor runs one-shot tasks on the supervised worker in both the standard and isolated profiles, with full model selection, cancellation, stall handling and a task transcript.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#115",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: ["tasks.execution.classes", "tasks.execution.profiles"],
    auditGaps: ["comparison-task-facet"],
    evidence: [
      test("src/lib/agent-backends/cursor/task-runner.test.ts"),
      test("src/lib/agent-backends/task-execution.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "agent-run-cli",
    area: "tasks",
    claim:
      "`cctl agent run` and the agent-runs API accept Cursor and execute it through the same admitted task path as any other backend.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#115",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-agent-run-cli"],
    evidence: [
      test("src/lib/agent-runs/route-handlers.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "production-continuity-binding",
    area: "tasks",
    claim:
      "Workflow and collaboration consumers resolve a real continuity binding — conversation identity, working directory, store and validated model — instead of the refusal the Phase 1 wiring supplied.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#115",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["defect-3-continuity-binding"],
    evidence: [
      test("src/lib/agent-backends/cursor/continuity-binding.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- assistance ------------------------------------------------------
  {
    id: "ticket-command",
    area: "assistance",
    claim:
      "`/ticket` generates its fields through the originating Cursor conversation rather than refusing or borrowing another backend.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-ticket-command"],
    evidence: [test("src/lib/tickets/slash-command.test.ts"), APPLICATION_PASS],
  },
  {
    id: "quick-ticket-enrichment",
    area: "assistance",
    claim:
      "Quick Ticket enrichment runs as an isolated one-shot Cursor task when Cursor is the configured backend.",
    mechanism: "cc-owned",
    limitation:
      "The triage note is refused, not truncated, when it exceeds the 2 KiB budget the prompt states, so an over-long answer leaves the ticket with its diagnostic report and no triage note.",
    owner: "command-center#116",
    verdict: "unresolved",
    blocker:
      "In two of two authenticated runs Cursor's triage note exceeded the 2 KiB enrichment budget (2354 and 2251 bytes) and the enrichment failed closed, so no Quick Ticket on Cursor received a triage note; the budget or the failure mode needs a decision before this row can pass.",
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-quick-ticket-enrichment"],
    evidence: [test("src/lib/tickets/enrichment.test.ts"), APPLICATION_PASS],
  },
  {
    id: "conversation-naming",
    area: "assistance",
    claim:
      "Cursor can be selected as the conversation-naming backend and produces names through the configured naming task.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-conversation-naming"],
    evidence: [
      test("src/lib/conversations/name-generation.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "session-naming",
    area: "assistance",
    claim:
      "Session names come from the configured naming backend, so a Cursor-only deployment no longer depends on a hardcoded Claude call.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-session-naming"],
    evidence: [test("src/lib/sessions/service.test.ts"), APPLICATION_PASS],
  },
  {
    id: "compaction-generation",
    area: "assistance",
    claim:
      "Cursor can be the configured compaction backend and generates the context artifact itself.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-compaction"],
    evidence: [
      test("src/lib/context-artifacts/service.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "commit-merge-message",
    area: "assistance",
    claim:
      "`/commit` and `/merge` generate their message through the Cursor conversation instead of falling back to the default text.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-commit-merge-message"],
    evidence: [
      test("src/lib/conversation-commands/service.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "validation-fix",
    area: "assistance",
    claim:
      "Smart Commit and Smart Merge repair failing validations through a Cursor task in the merge worktree.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-validation-fix"],
    evidence: [
      test("src/lib/workflows/auxiliary-cursor.test.ts"),
      report(FINAL_REPORT),
    ],
  },
  {
    id: "conflict-resolution",
    area: "assistance",
    claim:
      "Conflict analysis and resolution run as a two-turn Cursor task, the second turn returning the structured result the domain validates.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#116",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-conflict-resolution"],
    evidence: [
      test("src/lib/workflows/auxiliary-cursor.test.ts"),
      test("src/lib/sessions/conflict-resolution.test.ts"),
      report(FINAL_REPORT),
    ],
  },

  // ----- workflows -------------------------------------------------------
  {
    id: "workflow-assignments",
    area: "workflows",
    claim:
      "Cursor is assignable as a graph workflow implementer, validator, plan-repair agent and collaboration second agent, in the schema, the assignment editor and the config cascade.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#118",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-workflow-assignments"],
    evidence: [
      test("src/lib/workflow-graph/config-schemas.test.ts"),
      test("src/lib/workflow-graph/definition-validation.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "workflow-auxiliary-runners",
    area: "workflows",
    claim:
      "Validator, advisory-response, output-capture and plan-repair runs execute on Cursor, inheriting the assignment's backend rather than requiring a Claude fallback.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#118",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-auxiliary-runners"],
    evidence: [
      test("src/lib/workflow-graph/validator-runner.test.ts"),
      test("src/lib/workflow-graph/plan-repair/agent-runner.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "owned-workflow-writes",
    area: "workflows",
    claim:
      "Path-owned and read-only workflow placements accept Cursor: the same write envelope Claude receives is composed, delivered and briefed in the implementer prompt.",
    mechanism: "instruction-only",
    limitation:
      "The write envelope is delivered as instructions, so a Cursor lane can write outside its owned paths; ownership violations are detected after the fact rather than prevented.",
    owner: "command-center#118",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-owned-workflow-writes"],
    evidence: [
      test(
        "src/lib/workflow-graph/implementer-write-envelope.integration.test.ts",
      ),
      live("instructions.acceptance.test.ts", "instructions-durable-resume"),
      live(
        "instructions.acceptance.test.ts",
        "validator-instruction-policy-resume",
      ),
      APPLICATION_PASS,
    ],
  },
  {
    id: "spec-managed-delivery",
    area: "workflows",
    claim:
      "A native spec's managed delivery workflow can be staffed with Cursor, and that staffing survives freeze, reload and reopen.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#118",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-spec-delivery"],
    evidence: [
      test("src/lib/specs/managed-workflow-definition-service.test.ts"),
      test("src/lib/workflow-graph/workflow-manager.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- collaboration ---------------------------------------------------
  {
    id: "collaboration-mode",
    area: "collaboration",
    claim:
      "Cursor participates in Collaboration Mode in either position, against Claude, Codex or Cursor, with its lanes dispatched as task runs. A standalone /collab releases the originating conversation's idle worker after claiming the conversation, so Agent One can resume that agent even seconds after a Cursor turn.",
    mechanism: "cc-owned",
    limitation:
      "A collaboration lane's autonomous settings cannot be enforced on Cursor, so sandbox, network and approval limits are delivered as instructions and disclosed in the collaboration row.",
    owner: "command-center#119",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-collaboration"],
    evidence: [
      test("src/lib/workflows/collaboration/backend-pair.test.ts"),
      test("src/lib/workflows/collaboration/backend-refusal.test.ts"),
      test("src/lib/workflows/collaboration/agent-caller-production.test.ts"),
      test("src/lib/workflows/collaboration/manager.test.ts"),
      test("src/lib/workflows/conversation/manager.test.ts"),
      APPLICATION_PASS,
    ],
  },

  // ----- observability ---------------------------------------------------
  {
    id: "billed-cost",
    area: "observability",
    claim:
      "A durable per-conversation ledger reconciles the provider's billed usage entries against Command Center turns and settles late charges as they arrive.",
    mechanism: "cc-owned",
    limitation:
      "An account whose key cannot reach the usage endpoint records a durable unavailable state and reports no cost at all, rather than estimating one.",
    owner: "command-center#120",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["comparison-cost"],
    evidence: [
      test("src/lib/agent-backends/cursor/billing-ledger.test.ts"),
      test(
        "src/lib/agent-backends/cursor/conversation-runtime.billing.test.ts",
      ),
      test("src/lib/conversations/cost-settlement.test.ts"),
      live("billing.acceptance.test.ts", "billing-one-turn"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "per-turn-cost-attribution",
    area: "observability",
    claim:
      "Per-turn cost is inferred from the provider's usage entries and stays unknown when it cannot be attributed.",
    mechanism: "unavailable",
    limitation:
      "Cost shown for a Cursor turn is an attribution Command Center inferred, not a figure the provider tied to that run.",
    owner: "command-center#120",
    verdict: "unresolved",
    blocker:
      "The provider never links a billing entry to the run that produced it, and host-supplied usage identifiers are not accepted, so exact per-turn attribution is unobtainable.",
    liveFlow: false,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/billing-ledger-store.test.ts"),
      live("cancellation.acceptance.test.ts", "cancel-usage-attribution"),
    ],
  },
  {
    id: "context-occupancy",
    area: "observability",
    claim:
      "Context occupancy is reported as unknown. Billing token counts are never presented as a window measurement, and the UI says so.",
    mechanism: "unavailable",
    limitation:
      "No numeric context threshold can be enforced for Cursor, so occupancy-driven rotation is unavailable and the transcript shows Context unknown.",
    owner: "command-center#121",
    verdict: "unresolved",
    blocker:
      "The SDK publishes neither an effective context-window maximum nor current occupancy; public usage figures are billing totals, and checkpoint blobs are not a metrics API.",
    liveFlow: false,
    facts: ["conversation.capabilities.contextWindowMetrics"],
    auditGaps: ["comparison-context-metrics"],
    evidence: [
      test("src/lib/agent-backends/cursor/descriptor.test.ts"),
      report("docs/reports/2026-09-18-cursor-native-context.md"),
    ],
  },
  {
    id: "native-compaction-observation",
    area: "observability",
    claim:
      "A native summary message observed during a turn becomes a durable conversation notice and sets the neutral compaction signal, which a configured context-limit policy can rotate on.",
    mechanism: "cc-owned",
    limitation:
      "The signal confirms that the provider produced a summary, not that context was successfully replaced or when that replacement began and ended.",
    owner: "command-center#121",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: ["feature-context-thresholds"],
    evidence: [
      test("src/lib/agent-backends/cursor/transcript-projections.test.ts"),
      report("docs/reports/2026-09-18-cursor-native-context.md"),
      APPLICATION_PASS,
    ],
  },

  // ----- policy ----------------------------------------------------------
  {
    id: "capability-admission",
    area: "policy",
    claim:
      "Admission is decided from declared execution classes and task profiles, not from a backend name or a single task-facet boolean, so a consumer opens for Cursor only when the class it needs is declared.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#111",
    verdict: "verified",
    blocker: null,
    liveFlow: false,
    facts: ["conversation.execution.classes"],
    auditGaps: ["defect-4-task-profile-gating"],
    evidence: [
      test("src/lib/agent-backends/execution-admission.test.ts"),
      test("src/lib/agent-backends/facet-gating.test.ts"),
      test("src/lib/agent-backends/conformance.test.ts"),
    ],
  },
  {
    id: "privileged-instructions",
    area: "policy",
    claim:
      "Governed instructions reach Cursor as a fenced System Instructions block at the head of the first user message, on create and on resume, and the descriptor says so.",
    mechanism: "instruction-only",
    limitation:
      "The block has no system priority, so governed instructions are advisory text the model may weigh against the rest of the conversation.",
    owner: "command-center#117",
    verdict: "unresolved",
    blocker:
      "AgentOptions exposes no system or developer instruction field, so no privileged channel exists to deliver governed instructions through.",
    liveFlow: true,
    facts: [
      "conversation.execution.instructionDelivery",
      "tasks.execution.instructionDelivery",
    ],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/cursor/runtime-config.test.ts"),
      live("instructions.acceptance.test.ts", "instructions-durable-resume"),
    ],
  },
  {
    id: "filesystem-confinement",
    area: "policy",
    claim:
      "A filesystem write policy supplied to Cursor is translated into explicit instructions and is declared instruction-only on both facets; an unrepresentable policy is refused at the adapter boundary rather than silently dropped.",
    mechanism: "instruction-only",
    limitation:
      "There is no mechanical confinement: a Cursor agent can write outside its allowed paths, and the declaration exists so no consumer mistakes the instruction for an enforced envelope.",
    owner: "command-center#117",
    verdict: "unresolved",
    blocker:
      "SandboxOptions exposes only an enabled flag, with no path allowlist and no coverage of shell, direct file tools, MCP or subagents, so an exact write envelope cannot be expressed.",
    liveFlow: true,
    facts: ["conversation.fsWriteRestriction", "tasks.fsWriteRestriction"],
    auditGaps: ["comparison-fs-write", "defect-5-fs-policy-refusal"],
    evidence: [
      test("src/lib/agent-backends/cursor/task-runner.test.ts"),
      test(
        "src/lib/workflow-graph/implementer-write-envelope.integration.test.ts",
      ),
      live("instructions.acceptance.test.ts", "instructions-durable-resume"),
    ],
  },
  {
    id: "native-memory-neutralization",
    area: "policy",
    claim:
      "Command Center delivers its shared-memory policy to Cursor as an instruction and declares that it has no mechanism to disable the provider's own memory.",
    mechanism: "instruction-only",
    limitation:
      "Cursor's native memory may remain active alongside Command Center memory, and its state cannot be read back to confirm otherwise.",
    owner: "command-center#124",
    verdict: "unresolved",
    blocker:
      "The SDK carries no memory field an embedder can set; the only memory switch in the package belongs to the server-delivered feature config.",
    liveFlow: true,
    facts: ["nativeMemory.mechanism", "nativeMemory.reason"],
    auditGaps: ["comparison-native-memory", "feature-shared-memory"],
    evidence: [
      test("src/lib/agent-backends/native-memory.contract.test.ts"),
      live(
        "native-memory.acceptance.test.ts",
        "native-memory-conversation-fallback",
      ),
      live("native-memory.acceptance.test.ts", "native-memory-task-fallback"),
    ],
  },
  {
    id: "execution-warnings",
    area: "policy",
    claim:
      "Every instruction-only limit is disclosed in the backend's execution warnings, shown wherever Cursor is selected, and none of them disables a supported feature or demands an acknowledgement.",
    mechanism: "cc-owned",
    limitation: null,
    owner: "command-center#117",
    verdict: "verified",
    blocker: null,
    liveFlow: true,
    facts: [],
    auditGaps: [],
    evidence: [
      test("src/lib/agent-backends/catalog.test.ts"),
      test("src/lib/agent-backends/cursor/descriptor.test.ts"),
      APPLICATION_PASS,
    ],
  },
  {
    id: "network-approval-limits",
    area: "policy",
    claim:
      "Network access and native tool approvals are not restricted for Cursor, and the execution warning states that plainly instead of implying a sandbox.",
    mechanism: "unavailable",
    limitation:
      "A Cursor turn reaches the network and runs native tools without Command Center approval gating, so it must be treated as an unsandboxed agent on the host.",
    owner: "command-center#117",
    verdict: "verified",
    blocker: null,
    liveFlow: false,
    facts: [],
    auditGaps: [],
    evidence: [test("src/lib/agent-backends/cursor/policy.test.ts")],
  },
];

// ---------------------------------------------------------------------------
// Live capability facts
// ---------------------------------------------------------------------------

function renderFactValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? "(none)"
      : value.map((entry) => renderFactValue(entry)).join(", ");
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value)
      .map((entry) => renderFactValue(entry))
      .join(":");
  }
  return String(value);
}

function collectFacts(
  prefix: string,
  value: unknown,
  into: Record<string, string>,
): void {
  // An array is a leaf even when it holds objects: `capabilityKinds` is one
  // capability statement, and splitting it by index would make the fact keys
  // depend on how many kinds happen to be declared.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectFacts(`${prefix}.${key}`, child, into);
    }
    return;
  }
  into[prefix] = renderFactValue(value);
}

/**
 * Every capability Cursor's registered descriptor publishes, flattened to
 * dotted keys.
 *
 * Derived from the live objects rather than listed, which is what makes the
 * matrix's coverage check meaningful: a new capability field appears here on
 * its own and fails the suite until some row accounts for it.
 */
export function describeCursorDescriptorFacts(): Readonly<
  Record<string, string>
> {
  const facts: Record<string, string> = {};
  collectFacts("conversation.execution", cursorConversationExecution, facts);
  collectFacts(
    "conversation.capabilities",
    cursorConversationCapabilities,
    facts,
  );
  collectFacts(
    "conversation.fsWriteRestriction",
    cursorConversationFsWriteRestriction,
    facts,
  );
  collectFacts("tasks.execution", cursorTaskExecution, facts);
  collectFacts("tasks.fsWriteRestriction", cursorTaskFsWriteRestriction, facts);
  collectFacts("tasks.structuredOutput", cursorTaskStructuredOutput, facts);
  collectFacts("managedSkills", cursorManagedSkills, facts);
  collectFacts("nativeMemory", cursorNativeMemory, facts);
  // `backend` is the registry key, not a capability.
  const { backend: _backend, ...mcp } = cursorMcpCapabilities;
  collectFacts("mcp", mcp, facts);
  return facts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Markdown tables are newline- and pipe-delimited, and several claims contain
 *  a pipe-free but multi-clause sentence; only the delimiter needs escaping. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function renderEvidence(entry: CursorParityEvidence): string {
  if (entry.kind === "acceptance-case") return `live: \`${entry.caseId}\``;
  return `\`${entry.file}\``;
}

const AREA_TITLES: Readonly<Record<CursorParityArea, string>> = {
  runtime: "Runtime, authentication and cleanup",
  conversation: "Conversations",
  continuity: "Continuity, queueing and forks",
  interaction: "In-turn interaction and background work",
  capabilities: "Skills, plugins and agents",
  mcp: "MCP",
  tasks: "One-shot tasks",
  assistance: "Agent-assisted product features",
  workflows: "Graph workflows and spec delivery",
  collaboration: "Collaboration Mode",
  observability: "Cost and context",
  policy: "Execution policy and disclosure",
};

/**
 * The matrix as the final report publishes it.
 *
 * Rendered rather than written by hand so the report cannot drift from the
 * declarations the suite checks — the fenced section in the document is
 * compared against this output byte for byte.
 */
export function renderCursorParityMatrix(
  rows: readonly CursorParityRow[],
): string {
  const sections: string[] = [];
  for (const area of CURSOR_PARITY_AREAS) {
    const areaRows = rows.filter((row) => row.area === area);
    if (areaRows.length === 0) continue;
    const lines = [
      `### ${AREA_TITLES[area]}`,
      "",
      "| Row | Verdict | Mechanism | What Cursor does | Limitation or blocker | Owner | Evidence |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const row of areaRows) {
      const disclosure =
        row.blocker === null
          ? (row.limitation ?? "—")
          : `**Unresolved:** ${row.blocker}${
              row.limitation === null ? "" : ` ${row.limitation}`
            }`;
      lines.push(
        `| \`${row.id}\` | ${row.verdict} | ${row.mechanism} | ${cell(
          row.claim,
        )} | ${cell(disclosure)} | ${row.owner} | ${row.evidence
          .map((entry) => renderEvidence(entry))
          .join("<br>")} |`,
      );
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

/**
 * The capability disclosure the user-facing support document publishes.
 *
 * Read straight out of the registered descriptor, so the support document
 * cannot advertise a restriction the backend no longer declares — the stale
 * Phase 1 list is exactly the failure this replaces.
 */
export function renderCursorCapabilityDisclosure(): string {
  const facts = describeCursorDescriptorFacts();
  const lines = ["| Declared capability | Value |", "| --- | --- |"];
  for (const [key, value] of Object.entries(facts)) {
    lines.push(`| \`${key}\` | ${cell(value)} |`);
  }
  return lines.join("\n");
}
