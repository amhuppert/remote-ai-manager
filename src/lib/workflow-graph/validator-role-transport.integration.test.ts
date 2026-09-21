/** Final provider instructions through the durable conversation actor. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScriptedConversationBackend } from "@/lib/agent-backends/testing/scripted-conversation-backends";
import {
  PROFILE_LAYER_HEADING,
  buildAgentProfileSnapshot,
} from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { WHOLE_TREE_CANDIDATE_SCOPE } from "@/lib/git/diff";
import { createTestGraphExecutionContract } from "./testing/execution-contract";
import { createValidatorConversationHarness } from "./testing/validator-conversation-harness";
import { WORKFLOW_ROLE_CONTRACT_HEADING } from "./role-instructions";
import { createValidatorRunner } from "./validator-runner";
import {
  createWorkflowExecution,
  makeStubValidatorContinuityService,
} from "./test-fixtures";
import type { SeededValidatorAssignment } from "./config-schemas";

vi.mock("@/lib/shared/sdk-env", () => ({}));

const WORKTREE_PATH = mkdtempSync(path.join(tmpdir(), "cc-role-transport-wt-"));
const PROFILE_SENTINEL = "PROFILE_LENS_SENTINEL";
const PROFILE_INSTRUCTIONS = `Focus on the review lens. ${PROFILE_SENTINEL}`;
const VERDICT_TEXT = JSON.stringify({
  summary: "ok",
  issues: [],
  advisories: [],
});

async function runValidator(backend: "claude" | "codex") {
  const provider = createScriptedConversationBackend({
    backend,
    responseText: VERDICT_TEXT,
  });
  const validator: SeededValidatorAssignment = {
    id: "reviewer",
    profile: { tier: "builtin", id: "general-reviewer" },
    profileSnapshot: buildAgentProfileSnapshot({
      tier: "builtin",
      id: "general-reviewer",
      name: "General Reviewer",
      revision: 1,
      sourceContentHash: computeContentHash(PROFILE_INSTRUCTIONS),
      instructions: PROFILE_INSTRUCTIONS,
    }),
    authority: "blocking",
    agent:
      backend === "claude"
        ? {
            backend,
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          }
        : {
            backend,
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
          },
  };
  const execution = createWorkflowExecution();
  const baseContext = execution.workingDefinition.executionContexts[0];
  if (!baseContext) throw new Error("Missing test context");
  const context = {
    ...baseContext,
    contextValidator: { enabled: true, assignments: [validator] },
  };
  const runner = createValidatorRunner({
    executionContract: createTestGraphExecutionContract(),
    resolveWorktreePath: async () => WORKTREE_PATH,
    ...createValidatorConversationHarness({
      backendFactory: provider.factory,
      execution,
      context,
      validator,
      worktreePath: WORKTREE_PATH,
    }),
    computeValidationDiffScope: async () => ({
      kind: "unavailable",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      reason: "test",
    }),
    readLaneConversation: async () => null,
    continuityService: makeStubValidatorContinuityService(),
  });
  try {
    const result = await runner.runContextValidator({
      projectPath: "/repo-role-transport",
      sessionName: "role-session",
      execution,
      context,
      validator,
    });
    expect(result.result.kind, JSON.stringify(result.result)).toBe("pass");
    return {
      instructions: provider.privilegedInstructions,
      prompt: provider.userPrompt,
    };
  } finally {
    provider.close();
  }
}

describe.each(["claude", "codex"] as const)(
  "validator role transport to %s",
  (backend) => {
    it("delivers the role contract before exactly one subordinate persisted profile in the provider's privileged channel", async () => {
      const { instructions } = await runValidator(backend);
      const contractAt = instructions.indexOf(WORKFLOW_ROLE_CONTRACT_HEADING);
      const profileAt = instructions.indexOf(PROFILE_LAYER_HEADING);
      expect(contractAt).toBeGreaterThanOrEqual(0);
      expect(profileAt).toBeGreaterThan(contractAt);
      expect(
        instructions.match(new RegExp(PROFILE_SENTINEL, "g")),
      ).toHaveLength(1);
      expect(instructions).toContain("subordinate specialization lens");
    });

    it("keeps role and profile instructions out of the provider's user input", async () => {
      const { prompt } = await runValidator(backend);
      expect(prompt).not.toContain(WORKFLOW_ROLE_CONTRACT_HEADING);
      expect(prompt).not.toContain(PROFILE_SENTINEL);
      expect(prompt).not.toContain("## System Instructions");
      expect(prompt).toContain("Context Validation");
    });
  },
);
