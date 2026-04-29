/**
 * Production deps-factory tests for Collaboration Mode.
 *
 * These tests verify that `createCollaborationDeps` returns a fully-shaped
 * `CollaborationSliceDeps` so a route handler / manager can call
 * `runCollaborationSlice(input, deps)` with the result without further
 * threading. We deliberately do NOT exercise the full slice here — the slice
 * has its own coverage in `slice.test.ts`. The shape and the in-process
 * StatusBus default behavior are what callers depend on.
 *
 * `vi.mock` is intentionally avoided per project standards: the production
 * factory is invoked directly. Filesystem-backed sub-services (envelope
 * store, artifact registry) are constructed but never written through, so
 * the lazy `require("@/lib/state")` call doesn't actually hit disk.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCollaborationDeps } from "./deps-factory";
import {
  runCollaborationSlice,
  type CollaborationSliceDeps,
  type CollaborationSliceInput,
} from "./slice";
import type {
  CollaborationAgent,
  CollaborationDecision,
  CollaborationRoundResponse,
} from "./types";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/workflows/primitives/status-bus";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";

function makeStubCallAgent(): CollaborationSliceDeps["callAgent"] {
  return vi.fn(async () => {
    throw new Error(
      "stub callAgent should not be invoked during deps-factory tests",
    );
  });
}

const baseInput = {
  projectPath: "/tmp/projects/example",
  sessionName: "collab-session",
  worktreePath: "/tmp/projects/example/.worktrees/collab-session",
};

describe("createCollaborationDeps", () => {
  it("returns a fully-shaped CollaborationSliceDeps", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(typeof deps.callAgent).toBe("function");
    expect(deps.laneService).toBeDefined();
    expect(typeof deps.laneService.resolve).toBe("function");
    expect(typeof deps.laneService.initialize).toBe("function");
    expect(typeof deps.laneService.recordOutcome).toBe("function");
    expect(deps.laneScheduler).toBeDefined();
    expect(typeof deps.laneScheduler.schedule).toBe("function");
    expect(deps.envelopeStore).toBeDefined();
    expect(typeof deps.envelopeStore.read).toBe("function");
    expect(typeof deps.envelopeStore.upsert).toBe("function");
    expect(deps.artifactRegistry).toBeDefined();
    expect(typeof deps.artifactRegistry.write).toBe("function");
    expect(typeof deps.artifactRegistry.register).toBe("function");
    expect(deps.statusBus).toBeDefined();
    expect(typeof deps.statusBus.publish).toBe("function");
    expect(typeof deps.statusBus.subscribe).toBe("function");
  });

  it("forwards the injected callAgent verbatim", () => {
    const callAgent = makeStubCallAgent();
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent,
    });

    expect(deps.callAgent).toBe(callAgent);
  });

  it("default StatusBus delivers published envelopes to in-process subscribers", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    const received: StatusBusEnvelope[] = [];
    const unsubscribe = deps.statusBus.subscribe((envelope) => {
      received.push(envelope);
    });

    const outcome = deps.statusBus.publish({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });

    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });
  });

  it("honors a caller-supplied StatusBus override", () => {
    const overrideBus = createStatusBus({ broadcast: () => {} });

    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
      statusBus: overrideBus,
    });

    expect(deps.statusBus).toBe(overrideBus);
  });

  it("creates fresh lane state per call but shares the production scheduler across runs", () => {
    const a = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });
    const b = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(a.laneService).not.toBe(b.laneService);
    expect(a.laneScheduler).toBe(b.laneScheduler);
    expect(a.statusBus).not.toBe(b.statusBus);
  });
});

function makeAgentCallResult(
  backend: "claude" | "codex",
  structuredOutput: CollaborationRoundResponse,
): AgentCallResult {
  return {
    backend,
    backendRef:
      backend === "claude"
        ? { backend: "claude", sessionId: `sess-${backend}` }
        : { backend: "codex", threadId: `th-${backend}` },
    capabilities: {
      backend,
      continuationStrength:
        backend === "claude" ? "precise_session" : "synthetic_thread",
      structuredOutputEnforcement:
        backend === "claude" ? "post_validation" : "backend_native",
      mcpApplicationBoundary:
        backend === "claude" ? "between_turns" : "per_request",
      contextMetricsAvailable: backend === "claude",
      nativeMidTurnAskUser: backend === "claude",
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: {
      kind: "completed",
      text: structuredOutput.designDocument,
      structuredOutput,
    },
  };
}

function makeScribeResult(
  backend: "claude" | "codex",
  mergedDesign: string,
): AgentCallResult {
  return {
    backend,
    backendRef:
      backend === "claude"
        ? { backend: "claude", sessionId: `sess-scribe-${backend}` }
        : { backend: "codex", threadId: `th-scribe-${backend}` },
    capabilities: {
      backend,
      continuationStrength:
        backend === "claude" ? "precise_session" : "synthetic_thread",
      structuredOutputEnforcement:
        backend === "claude" ? "post_validation" : "backend_native",
      mcpApplicationBoundary:
        backend === "claude" ? "between_turns" : "per_request",
      contextMetricsAvailable: backend === "claude",
      nativeMidTurnAskUser: backend === "claude",
    },
    usage: { durationMs: 1 },
    artifacts: [],
    outcome: {
      kind: "completed",
      text: mergedDesign,
      structuredOutput: undefined,
    },
  };
}

function makeRoundResponse(
  agent: CollaborationAgent,
  round: number,
  decision: CollaborationDecision,
  designDocument: string,
): CollaborationRoundResponse {
  return {
    agent,
    round,
    overallAssessment: `${agent} round ${round} assessment`,
    agreements: [],
    disagreements: [],
    openQuestions: [],
    designDocument,
    decision,
  };
}

describe("createCollaborationDeps — converged collaboration registers artifacts via the production registry path", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "collab-deps-factory-"),
    );
  });

  it("runs a converged collaboration end-to-end and registers all three artifacts through the production reference-document hook", async () => {
    const claudeRound1 = makeRoundResponse(
      "claude",
      1,
      "accept",
      "# Claude design v1",
    );
    const codexRound1 = makeRoundResponse(
      "codex",
      1,
      "accept",
      "# Codex design v1",
    );

    const claudeQueue: AgentCallResult[] = [
      makeAgentCallResult("claude", claudeRound1),
      makeScribeResult("claude", "# Merged design\n\nFinal merged content."),
    ];
    const codexQueue: AgentCallResult[] = [
      makeAgentCallResult("codex", codexRound1),
    ];

    const callAgent: CollaborationSliceDeps["callAgent"] = async (
      request: AgentCallRequest,
    ) => {
      const backend =
        request.kind === "conversation_turn"
          ? (request.backend ?? "claude")
          : request.backend;
      const queue = backend === "claude" ? claudeQueue : codexQueue;
      const next = queue.shift();
      if (!next) {
        throw new Error(`programmed callAgent drained for backend ${backend}`);
      }
      return next;
    };

    const referenceDocRegistrations: Array<{
      projectPath: string;
      sessionName: string;
      filePath: string;
      description: string;
    }> = [];

    const deps = createCollaborationDeps({
      projectPath: "/projects/example",
      sessionName: "collab-session",
      worktreePath: workingDir,
      callAgent,
      envelopeStore: createInMemoryWorkflowEnvelopeStore(),
      laneService: createLaneService({ store: createInMemoryLaneStore() }),
      registerReferenceDocument: async (input) => {
        referenceDocRegistrations.push(input);
      },
    });

    const input: CollaborationSliceInput = {
      workflowId: "collab-prod-1",
      brief: "Design Collaboration Mode artifact wiring.",
      worktreePath: workingDir,
      sessionKey: "collab-deps-factory/converged",
      maxIterations: 4,
      scribeBackend: "claude",
    };

    const result = await runCollaborationSlice(input, deps);

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.rounds).toBe(1);
    expect(result.mergedDesignArtifactId).toBeTruthy();
    expect(result.transcriptArtifactId).toBeTruthy();
    expect(result.openQuestionsArtifactId).toBeTruthy();

    const registeredPaths = referenceDocRegistrations
      .map((r) => r.filePath)
      .sort();
    expect(registeredPaths).toEqual([
      "memory-bank/collaboration/collab-prod-1/merged-design.md",
      "memory-bank/collaboration/collab-prod-1/open-questions.md",
      "memory-bank/collaboration/collab-prod-1/transcript.md",
    ]);

    for (const reg of referenceDocRegistrations) {
      expect(reg.projectPath).toBe("/projects/example");
      expect(reg.sessionName).toBe("collab-session");
      expect(reg.description).toMatch(/Collaboration Mode/);
    }

    const merged = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/collab-prod-1/merged-design.md",
      ),
      "utf-8",
    );
    expect(merged).toContain("# Merged design");

    const transcript = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/collab-prod-1/transcript.md",
      ),
      "utf-8",
    );
    expect(transcript).toContain("Claude design v1");
    expect(transcript).toContain("Codex design v1");

    const openQuestions = await fs.readFile(
      path.join(
        workingDir,
        "memory-bank/collaboration/collab-prod-1/open-questions.md",
      ),
      "utf-8",
    );
    expect(openQuestions).toContain("Collaboration Mode open questions");
  });
});
