/**
 * Tests for `parseAndInjectArtifact`: the orchestrator parses a phase turn's
 * model-authored content, then injects the bookkeeping it owns (envelope
 * kind/agent/target_agent/round and each generated artifact's round/agent/phase)
 * to reconstruct the full persisted artifact.
 *
 * Pure function, no mocks: the real content + full Zod schemas validate a hand
 * built structured output. The confidence test holds — replacing the helper with
 * a pass-through would fail the injection and round-trip assertions.
 */
import { describe, expect, it } from "vitest";

import { callPrimitive, parseAndInjectArtifact } from "./helpers";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  collaborationArtifactSchema,
  collaborationProposedChangesContentSchema,
  collaborationProposedChangesOutputSchema,
} from "./types";
import {
  CHARTER_SUPERSEDES_NOTICE,
  EMPTY_COLLABORATION_SESSION_CONTEXT,
  type CollaborationSessionContext,
} from "./session-context";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
} from "./envelope";
import type { CollaborationAgent, CollaborationFlowAgent } from "./types";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createStatusBus } from "@/lib/events/status-bus";

function completed(structuredOutput: unknown): AgentCallResult {
  return {
    backend: "claude",
    backendRef: { backend: "claude", ref: "sess" },
    capabilities: {
      backend: "claude",
      continuationStrength: "precise_session",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "between_turns",
      contextMetricsAvailable: true,
      nativeMidTurnAskUser: true,
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: { kind: "completed", text: "synthetic", structuredOutput },
  };
}

const proposedChangesContent = {
  summary: "Primary proposed changes after reading Agent Two's draft.",
  artifacts: [
    {
      id: "main",
      artifact_type: "main_response",
      path: "memory-bank/collaboration/wf/round-2/agent_one/proposed_changes/main.md",
      summary: "Full proposed_changes response.",
    },
  ],
  accepted_from_other_agent_draft: [],
  proposed_changes: [],
  remaining_disagreements: [],
};

const injection = {
  kind: "proposed_changes" as const,
  agent: "agent_one" as const,
  target_agent: "agent_two" as const,
  round: 2,
};

describe("parseAndInjectArtifact", () => {
  it("injects orchestrator-owned envelope and per-artifact bookkeeping", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed(proposedChangesContent),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );

    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(outcome.value.kind).toBe("proposed_changes");
    expect(outcome.value.agent).toBe("agent_one");
    expect(outcome.value.target_agent).toBe("agent_two");
    expect(outcome.value.round).toBe(2);
    expect(outcome.value.artifacts[0]).toMatchObject({
      id: "main",
      round: 2,
      agent: "agent_one",
      phase: "proposed_changes",
    });
  });

  it("produces an artifact that round-trips through the persisted discriminated union", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed(proposedChangesContent),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );
    expect(outcome.success).toBe(true);
    if (!outcome.success) return;
    expect(collaborationArtifactSchema.safeParse(outcome.value).success).toBe(
      true,
    );
  });

  it("surfaces a legible schema_validation error when required content is missing", () => {
    const outcome = parseAndInjectArtifact(
      "agent_one",
      completed({ ...proposedChangesContent, artifacts: [] }),
      {
        contentSchema: collaborationProposedChangesContentSchema,
        fullSchema: collaborationProposedChangesOutputSchema,
        injection,
      },
    );

    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toContain(
      "proposed_changes (agent_one) schema_validation",
    );
    expect(outcome.error).toContain("artifacts:");
    expect(outcome.error).toContain('id "main"');
  });

  it("fails when the lane call did not complete", () => {
    const failed: AgentCallResult = {
      ...completed(proposedChangesContent),
      outcome: {
        kind: "failed",
        error: {
          failureKind: "backend_error",
          backend: "claude",
          message: "boom",
        },
      },
    };
    const outcome = parseAndInjectArtifact("agent_one", failed, {
      contentSchema: collaborationProposedChangesContentSchema,
      fullSchema: collaborationProposedChangesOutputSchema,
      injection,
    });

    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toContain("did not complete");
  });
});

/**
 * `callPrimitive` is the single seam that decorates every substantive
 * collaboration request with the run's captured session context. The prompt
 * builders and the graph-workflow collaborator stay context-free, so these tests
 * pin both channels here: the charter travels as governing
 * `systemInstructions`, the ticket view as a transient prompt prefix.
 *
 * Deps are real in-memory primitives (lane store/service, envelope store,
 * status bus) with a request-capturing `callAgent` — the composed request the
 * production seam would dispatch is the assertion surface.
 */
describe("callPrimitive session-context injection", () => {
  const CHARTER_TEXT =
    "<session-alignment>\ncharter v7 body\n</session-alignment>";
  const TICKET_BLOCK =
    "<active-ticket>\nCC-42: fix the thing\n</active-ticket>";

  function charterOnly(): CollaborationSessionContext {
    return {
      alignment: { version: 7, contentHash: "hash-7", text: CHARTER_TEXT },
      activeTicketBlock: null,
    };
  }

  function ticketOnly(): CollaborationSessionContext {
    return { alignment: null, activeTicketBlock: TICKET_BLOCK };
  }

  function both(): CollaborationSessionContext {
    return {
      alignment: { version: 7, contentHash: "hash-7", text: CHARTER_TEXT },
      activeTicketBlock: TICKET_BLOCK,
    };
  }

  const WORK_PROMPT = "Draft an answer to the user prompt.";
  const OUTPUT_SCHEMA = { type: "object" } as const;

  async function runCall(args: {
    sessionContext: CollaborationSessionContext;
    primaryAgentBackend?: CollaborationAgent;
    flowAgent?: CollaborationFlowAgent;
    agents?: AsymmetricCollaborationSliceInput["agents"];
  }): Promise<AgentCallRequest> {
    const primaryAgentBackend = args.primaryAgentBackend ?? "claude";
    const flowAgent = args.flowAgent ?? "agent_one";
    const backend: CollaborationAgent =
      flowAgent === "agent_one"
        ? primaryAgentBackend
        : primaryAgentBackend === "claude"
          ? "codex"
          : "claude";

    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    const workflowId = "wf-callprimitive";
    const laneBackends = { agent_one: backend, agent_two: backend } as const;
    for (const lane of ["agent_one", "agent_two"] as const) {
      await laneService.initialize({
        workflowId,
        laneId: lane,
        backend: laneBackends[lane],
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-05-01T00:00:00.000Z",
      });
    }

    const input: AsymmetricCollaborationSliceInput = {
      workflowId,
      brief: "Design Y.",
      worktreePath: "/tmp/does-not-matter",
      sessionKey: "tests/call-primitive",
      primaryAgentBackend,
      ...(args.agents !== undefined ? { agents: args.agents } : {}),
      negotiationRounds: 1,
      autonomousResolutionThreshold: "major",
      sessionContext: args.sessionContext,
    };

    const received: AgentCallRequest[] = [];
    const deps: AsymmetricCollaborationSliceDeps = {
      callAgent: async (request) => {
        received.push(request);
        return completed(proposedChangesContent);
      },
      laneService,
      envelopeStore: createInMemoryWorkflowEnvelopeStore(),
      statusBus: createStatusBus({ broadcast: () => {} }),
      now: () => "2026-05-01T00:00:00.000Z",
    };

    const outcome = await callPrimitive({
      input,
      deps,
      flowAgent,
      backend,
      prompt: { prompt: WORK_PROMPT, outputSchema: OUTPUT_SCHEMA },
    });
    expect(outcome.kind).toBe("ok");
    expect(received).toHaveLength(1);
    return received[0]!;
  }

  it("carries no session context and composes today's exact request when the snapshot is empty", async () => {
    const request = await runCall({
      sessionContext: EMPTY_COLLABORATION_SESSION_CONTEXT,
    });

    // Byte-identical pin: an empty snapshot must not add a key or change a byte.
    expect(request).toEqual({
      kind: "conversation_turn",
      backend: "claude",
      prompt: WORK_PROMPT,
      laneRef: { workflowId: "wf-callprimitive", laneId: "agent_one" },
      writeCapability: "write_capable",
      outputSchema: OUTPUT_SCHEMA,
    });
    expect(Object.keys(request)).not.toContain("systemInstructions");
  });

  it("delivers a charter-only snapshot as governing instructions and leaves the prompt untouched", async () => {
    const request = await runCall({ sessionContext: charterOnly() });

    expect(request.systemInstructions).toBe(
      `${CHARTER_TEXT}\n\n${CHARTER_SUPERSEDES_NOTICE}`,
    );
    expect(request.prompt).toBe(WORK_PROMPT);
  });

  it("delivers a ticket-only snapshot as a single prompt prefix with no governing instructions", async () => {
    const request = await runCall({ sessionContext: ticketOnly() });

    expect(request.systemInstructions).toBeUndefined();
    expect(request.prompt).toBe(`${TICKET_BLOCK}\n\n${WORK_PROMPT}`);
  });

  it("keeps the two channels separate when both are captured, prefixing the ticket block exactly once", async () => {
    const request = await runCall({ sessionContext: both() });

    expect(request.systemInstructions).toBe(
      `${CHARTER_TEXT}\n\n${CHARTER_SUPERSEDES_NOTICE}`,
    );
    expect(request.prompt).toBe(`${TICKET_BLOCK}\n\n${WORK_PROMPT}`);
    expect(request.prompt.startsWith(TICKET_BLOCK)).toBe(true);
    expect(request.prompt.split(TICKET_BLOCK)).toHaveLength(2);
    // The ticket block is never folded into the governing instructions.
    expect(request.systemInstructions).not.toContain(TICKET_BLOCK);
  });

  it("gives both lanes the identical charter and ticket block with primary=claude", async () => {
    const agentOne = await runCall({
      sessionContext: both(),
      primaryAgentBackend: "claude",
      flowAgent: "agent_one",
    });
    const agentTwo = await runCall({
      sessionContext: both(),
      primaryAgentBackend: "claude",
      flowAgent: "agent_two",
    });

    expect(agentOne.kind).toBe("conversation_turn");
    expect(agentTwo.kind).toBe("task_run");
    expect(agentTwo.systemInstructions).toBe(agentOne.systemInstructions);
    expect(agentTwo.prompt).toBe(agentOne.prompt);
    expect(agentOne.systemInstructions).toContain(CHARTER_TEXT);
    expect(agentOne.prompt.startsWith(TICKET_BLOCK)).toBe(true);
  });

  it("gives both lanes the identical charter and ticket block with primary=codex", async () => {
    const agentOne = await runCall({
      sessionContext: both(),
      primaryAgentBackend: "codex",
      flowAgent: "agent_one",
    });
    const agentTwo = await runCall({
      sessionContext: both(),
      primaryAgentBackend: "codex",
      flowAgent: "agent_two",
    });

    expect(agentOne.kind).toBe("task_run");
    expect(agentTwo.kind).toBe("conversation_turn");
    expect(agentTwo.systemInstructions).toBe(agentOne.systemInstructions);
    expect(agentTwo.prompt).toBe(agentOne.prompt);
    expect(agentOne.systemInstructions).toContain(CHARTER_TEXT);
    expect(agentOne.prompt.startsWith(TICKET_BLOCK)).toBe(true);
  });
});

/**
 * The lane's agent-profile layer rides the same governing channel as the
 * charter. The block is the STORED `renderedInstructionBlock`, appended
 * verbatim — never re-rendered — and the Standard Agent's empty block appends
 * nothing, so a default-staffed run composes byte-identical requests to a
 * profile-less one.
 */
describe("callPrimitive agent-profile delivery", () => {
  const EMPTY_CONTEXT = {
    alignment: null,
    activeTicketBlock: null,
  };

  function reviewerSnapshot(): AgentProfileSnapshot {
    return buildAgentProfileSnapshot({
      tier: "global",
      id: "reviewer",
      name: "Reviewer",
      revision: 3,
      sourceContentHash: computeContentHash("Review everything twice."),
      instructions: "Review everything twice.",
    });
  }

  function standardAgentSnapshot(): AgentProfileSnapshot {
    return buildAgentProfileSnapshot({
      tier: "builtin",
      id: "standard-agent",
      name: "Standard Agent",
      revision: 1,
      sourceContentHash: computeContentHash(""),
      instructions: "",
    });
  }

  function agentsWith(args: {
    agentOne?: AgentProfileSnapshot;
    agentTwo?: AgentProfileSnapshot;
  }): AsymmetricCollaborationSliceInput["agents"] {
    return {
      agent_one: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max" },
        },
        ...(args.agentOne !== undefined
          ? { profileSnapshot: args.agentOne }
          : {}),
      },
      agent_two: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        ...(args.agentTwo !== undefined
          ? { profileSnapshot: args.agentTwo }
          : {}),
      },
    };
  }

  it("delivers agent_two's stored rendered block verbatim as its only governing instructions", async () => {
    const snapshot = reviewerSnapshot();
    const request = await runProfileCall({
      flowAgent: "agent_two",
      agents: agentsWith({ agentTwo: snapshot }),
    });
    expect(request.systemInstructions).toBe(snapshot.renderedInstructionBlock);
  });

  it("appends the profile block after the charter on the same channel", async () => {
    const snapshot = reviewerSnapshot();
    const charter = {
      alignment: {
        version: 7,
        contentHash: "hash-7",
        text: "<session-alignment>\ncharter v7 body\n</session-alignment>",
      },
      activeTicketBlock: null,
    };
    const request = await runProfileCall({
      flowAgent: "agent_two",
      agents: agentsWith({ agentTwo: snapshot }),
      sessionContext: charter,
    });
    expect(request.systemInstructions).toContain(charter.alignment.text);
    expect(
      request.systemInstructions?.endsWith(snapshot.renderedInstructionBlock),
    ).toBe(true);
    expect(
      (request.systemInstructions ?? "").indexOf(charter.alignment.text),
    ).toBeLessThan(
      (request.systemInstructions ?? "").indexOf(
        snapshot.renderedInstructionBlock,
      ),
    );
  });

  it("appends nothing for the Standard Agent's empty block", async () => {
    const request = await runProfileCall({
      flowAgent: "agent_two",
      agents: agentsWith({ agentTwo: standardAgentSnapshot() }),
    });
    expect(Object.keys(request)).not.toContain("systemInstructions");
  });

  it("delivers agent_one's inherited snapshot to agent_one's lane only", async () => {
    const snapshot = reviewerSnapshot();
    const agents = agentsWith({
      agentOne: snapshot,
      agentTwo: standardAgentSnapshot(),
    });
    const agentOneRequest = await runProfileCall({
      flowAgent: "agent_one",
      agents,
    });
    const agentTwoRequest = await runProfileCall({
      flowAgent: "agent_two",
      agents,
    });
    expect(agentOneRequest.systemInstructions).toBe(
      snapshot.renderedInstructionBlock,
    );
    expect(Object.keys(agentTwoRequest)).not.toContain("systemInstructions");
  });

  async function runProfileCall(args: {
    flowAgent: CollaborationFlowAgent;
    agents: AsymmetricCollaborationSliceInput["agents"];
    sessionContext?: CollaborationSessionContext;
  }): Promise<AgentCallRequest> {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    const workflowId = "wf-profile-delivery";
    const backends = { agent_one: "claude", agent_two: "codex" } as const;
    for (const lane of ["agent_one", "agent_two"] as const) {
      await laneService.initialize({
        workflowId,
        laneId: lane,
        backend: backends[lane],
        writeCapability: "write_capable",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-05-01T00:00:00.000Z",
      });
    }

    const input: AsymmetricCollaborationSliceInput = {
      workflowId,
      brief: "Design Y.",
      worktreePath: "/tmp/does-not-matter",
      sessionKey: "tests/profile-delivery",
      primaryAgentBackend: "claude",
      agents: args.agents,
      negotiationRounds: 1,
      autonomousResolutionThreshold: "major",
      sessionContext: args.sessionContext ?? EMPTY_CONTEXT,
    };

    const received: AgentCallRequest[] = [];
    const deps: AsymmetricCollaborationSliceDeps = {
      callAgent: async (request) => {
        received.push(request);
        return completed(proposedChangesContent);
      },
      laneService,
      envelopeStore: createInMemoryWorkflowEnvelopeStore(),
      statusBus: createStatusBus({ broadcast: () => {} }),
      now: () => "2026-05-01T00:00:00.000Z",
    };

    const outcome = await callPrimitive({
      input,
      deps,
      flowAgent: args.flowAgent,
      backend: backends[args.flowAgent],
      prompt: { prompt: "Draft.", outputSchema: { type: "object" } },
    });
    expect(outcome.kind).toBe("ok");
    return received[0]!;
  }
});
