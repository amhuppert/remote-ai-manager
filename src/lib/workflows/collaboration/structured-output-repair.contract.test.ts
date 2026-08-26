import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { createStatusBus } from "@/lib/events/status-bus";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { createCollaborationProductionCallAgent } from "./agent-caller-production";
import type {
  AsymmetricCollaborationSliceDeps,
  AsymmetricCollaborationSliceInput,
} from "./envelope";
import { EMPTY_COLLABORATION_SESSION_CONTEXT } from "./session-context";
import type { ArtifactTracker } from "./helpers";
import { runInitialDraftsPhase } from "./initial-draft";
import type {
  CollaborationArtifact,
  CollaborationInitialDraftContent,
} from "./types";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function initialDraftContent(
  workflowId: string,
  agent: "agent_one" | "agent_two",
): CollaborationInitialDraftContent {
  return {
    summary: `${agent} completed its initial draft.`,
    artifacts: [
      {
        id: "main",
        artifact_type: "main_response",
        path: `memory-bank/collaboration/${workflowId}/round-0/${agent}/initial_draft/main.md`,
        summary: `${agent} initial-draft artifact.`,
      },
    ],
    assumptions: [],
    key_claims: [],
  };
}

async function writeMainArtifact(
  worktreePath: string,
  content: CollaborationInitialDraftContent,
): Promise<void> {
  const main = content.artifacts[0];
  if (!main) throw new Error("initial draft fixture has no main artifact");
  const absolutePath = path.join(worktreePath, main.path);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    `# Initial draft\n\n${content.summary}\n`,
    "utf-8",
  );
}

function conversationResult(text: string): ConversationBackendTurnResult {
  return {
    backendRef: { backend: "claude", ref: "claude-repair-session" },
    costUsd: null,
    durationMs: 10,
    numTurns: 1,
    contextTokens: null,
    contextWindowMax: null,
    contentBlocks: [{ type: "text", text }],
    structuredOutput: undefined,
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
  };
}

function taskResult(text: string, structuredOutput?: unknown): AgentTaskResult {
  return {
    backendRef: { backend: "codex", ref: "codex-format-thread" },
    text,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    usage: null,
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
  };
}

describe("collaboration structured-output repair contract", () => {
  it("repairs a malformed Claude manifest after the artifact is written and completes the initial-draft lanes", async () => {
    const worktreePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "collab-structured-repair-"),
    );
    createdDirectories.push(worktreePath);

    const workflowId = "wf-structured-output-repair";
    const claudeContent = initialDraftContent(workflowId, "agent_one");
    const codexContent = initialDraftContent(workflowId, "agent_two");
    const malformedManifest = {
      summary:
        `${claudeContent.summary}</summary>` +
        `<artifacts>${JSON.stringify(claudeContent.artifacts)}</artifacts>` +
        "<assumptions>[]</assumptions><key_claims>[]</key_claims>",
    };

    let claudeWorkTurns = 0;
    const claudeFormatPrompts: string[] = [];
    let artifactExistedBeforeRepair = false;
    const claudeFactory: ConversationBackendFactory = {
      backend: "claude",
      async createRuntime(input): Promise<ConversationBackendRuntime> {
        const isFormatRuntime = input.outputFormat !== undefined;
        let formatTurns = 0;
        return {
          backend: "claude",
          status: "alive",
          modelSelection: input.modelSelection,
          outputFormat: input.outputFormat,
          alignmentVersion: input.alignmentVersion ?? null,
          async sendTurn(turnInput): Promise<ConversationBackendTurnResult> {
            if (!isFormatRuntime) {
              claudeWorkTurns += 1;
              await writeMainArtifact(worktreePath, claudeContent);
              return conversationResult("Claude work turn completed.");
            }

            formatTurns += 1;
            claudeFormatPrompts.push(turnInput.promptText);
            if (formatTurns === 1) {
              return conversationResult(JSON.stringify(malformedManifest));
            }

            const mainPath = path.join(
              worktreePath,
              claudeContent.artifacts[0]!.path,
            );
            artifactExistedBeforeRepair =
              (await fs.readFile(mainPath, "utf-8")).length > 0;
            return conversationResult(JSON.stringify(claudeContent));
          },
          async close() {},
        };
      },
    };

    const codexRequests: AgentTaskRequest[] = [];
    const codexRunner: AgentTaskRunner = {
      backend: "codex",
      async run(request): Promise<AgentTaskResult> {
        codexRequests.push(request);
        if (request.outputSchema === undefined) {
          await writeMainArtifact(worktreePath, codexContent);
          return taskResult("Codex work turn completed.");
        }
        return taskResult(JSON.stringify(codexContent), codexContent);
      },
    };

    const laneService = createLaneService({
      store: createInMemoryLaneStore(),
    });
    for (const [laneId, backend] of [
      ["agent_one", "claude"],
      ["agent_two", "codex"],
    ] as const) {
      await laneService.initialize({
        workflowId,
        laneId,
        backend,
        writeCapability: "artifact_only",
        policy: { continuityEnabled: true },
        ref: null,
        metrics: { rotateBeforeNextTurn: false },
        lastUsedAt: "2026-07-23T12:00:00.000Z",
      });
    }

    const envelopeStore = createInMemoryWorkflowEnvelopeStore();
    await envelopeStore.upsert(workflowId, () => ({
      workflowId,
      workflowType: "collaboration",
      status: "running",
      phase: "asymmetric_initial_drafts",
      createdAt: "2026-07-23T12:00:00.000Z",
      updatedAt: "2026-07-23T12:00:00.000Z",
      featureSnapshot: {},
    }));

    const callAgent = createCollaborationProductionCallAgent({
      workflowId,
      projectPath: worktreePath,
      sessionName: "repair-contract",
      worktreePath,
      sessionKey: `${worktreePath}::repair-contract`,
      originatingConversationId: "originating-conversation",
      laneService,
      agents: {
        agent_one: {
          backend: "claude",
          modelSelection: {
            modelId: "claude-repair-model",
            parameters: { effort: "high" },
          },
        },
        agent_two: {
          backend: "codex",
          modelSelection: {
            modelId: "codex-repair-model",
            parameters: { reasoning: "high", fast: "false" },
          },
        },
      },
      getConversationBackendFactory: () => claudeFactory,
      getTaskRunner: () => codexRunner,
      now: () => "2026-07-23T12:00:00.000Z",
      newId: () => "repair-contract",
    });

    const registeredArtifacts: CollaborationArtifact[] = [];
    const tracker: ArtifactTracker = {
      artifacts: [],
      negotiationRoundsCompleted: 0,
      appendSink: async (artifact) => {
        registeredArtifacts.push(artifact);
      },
    };
    const input: AsymmetricCollaborationSliceInput = {
      workflowId,
      brief: "Produce two implementation drafts.",
      worktreePath,
      sessionKey: `${worktreePath}::repair-contract`,
      primaryAgentBackend: "claude",
      negotiationRounds: 1,
      autonomousResolutionThreshold: "major",
      sessionContext: EMPTY_COLLABORATION_SESSION_CONTEXT,
    };
    const deps: AsymmetricCollaborationSliceDeps = {
      callAgent,
      laneService,
      envelopeStore,
      statusBus: createStatusBus({ broadcast: () => {} }),
      now: () => "2026-07-23T12:00:00.000Z",
    };

    const outcome = await runInitialDraftsPhase({
      input,
      deps,
      now: deps.now!,
      tracker,
      ledger: null,
      backendForAgent: (agent) => (agent === "agent_one" ? "claude" : "codex"),
    });

    expect(outcome.kind).toBe("ok");
    expect(claudeWorkTurns).toBe(1);
    expect(claudeFormatPrompts).toHaveLength(2);
    expect(claudeFormatPrompts[1]).toContain("$.artifacts is required");
    expect(claudeFormatPrompts[1]).toContain(
      'Decoded top-level keys were ["summary"]',
    );
    expect(artifactExistedBeforeRepair).toBe(true);
    expect(codexRequests).toHaveLength(2);
    expect(tracker.artifacts).toHaveLength(2);
    expect(registeredArtifacts).toHaveLength(2);
    expect(
      registeredArtifacts
        .flatMap((artifact) => ("agent" in artifact ? [artifact.agent] : []))
        .sort(),
    ).toEqual(["agent_one", "agent_two"]);

    const claudeLane = await laneService.resolve({
      workflowId,
      laneId: "agent_one",
    });
    expect(claudeLane?.ref).toBe("claude-repair-session");
  });
});
