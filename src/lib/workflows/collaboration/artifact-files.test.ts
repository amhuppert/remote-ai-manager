import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collaborationArtifactDir,
  collaborationArtifactFilePath,
  readGeneratedArtifactFile,
  requiredArtifactFileRefs,
  validateGeneratedArtifactFiles,
} from "./artifact-files";
import type { CollaborationGeneratedArtifact } from "./types";

const baseContext = {
  workflowId: "wf-test",
  round: 1,
  agent: "agent_one" as const,
  phase: "proposed_changes" as const,
};

async function tempWorktree(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cc-collab-artifacts-"));
}

async function writeMarkdown(
  worktreePath: string,
  relativePath: string,
  content = "# Artifact\n\nBody",
): Promise<void> {
  const absolutePath = path.join(worktreePath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf-8");
}

function artifactRef(
  overrides: Partial<CollaborationGeneratedArtifact> = {},
): CollaborationGeneratedArtifact {
  return {
    id: "main",
    artifact_type: "main_response",
    path: collaborationArtifactFilePath(baseContext, "main.md"),
    round: baseContext.round,
    agent: baseContext.agent,
    phase: baseContext.phase,
    summary: "Main proposed changes artifact.",
    ...overrides,
  };
}

describe("collaboration generated artifact files", () => {
  it("builds canonical relative directories and file paths", () => {
    expect(collaborationArtifactDir(baseContext)).toBe(
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes",
    );
    expect(collaborationArtifactFilePath(baseContext, "main.md")).toBe(
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes/main.md",
    );
  });

  it("returns required refs for a non-final phase", () => {
    expect(requiredArtifactFileRefs(baseContext)).toEqual([
      {
        id: "main",
        artifact_type: "main_response",
        path: collaborationArtifactFilePath(baseContext, "main.md"),
        round: 1,
        agent: "agent_one",
        phase: "proposed_changes",
        summary: "Full proposed_changes response.",
      },
    ]);
  });

  it("returns answer and audit refs for final_answer", () => {
    expect(
      requiredArtifactFileRefs({
        ...baseContext,
        phase: "final_answer",
      }),
    ).toEqual([
      {
        id: "answer",
        artifact_type: "main_response",
        path: "memory-bank/collaboration/wf-test/round-1/agent_one/final_answer/answer.md",
        round: 1,
        agent: "agent_one",
        phase: "final_answer",
        summary: "Final answer.",
      },
      {
        id: "audit",
        artifact_type: "audit",
        path: "memory-bank/collaboration/wf-test/round-1/agent_one/final_answer/audit.md",
        round: 1,
        agent: "agent_one",
        phase: "final_answer",
        summary: "Final answer audit.",
      },
    ]);
  });

  it("validates and reads a generated artifact file", async () => {
    const worktreePath = await tempWorktree();
    const ref = artifactRef();
    await writeMarkdown(
      worktreePath,
      ref.path,
      "# Proposed changes\n\nUse it.",
    );

    await expect(
      validateGeneratedArtifactFiles({
        worktreePath,
        workflowId: baseContext.workflowId,
        artifact: {
          kind: "proposed_changes",
          agent: "agent_one",
          target_agent: "agent_two",
          round: 1,
          summary: "Proposal.",
          artifacts: [ref],
          accepted_from_other_agent_draft: [],
          proposed_changes: [],
          remaining_disagreements: [],
        },
      }),
    ).resolves.toEqual({ success: true, value: undefined });

    await expect(readGeneratedArtifactFile(worktreePath, ref)).resolves.toBe(
      "# Proposed changes\n\nUse it.",
    );
  });

  it.each([
    ["/tmp/main.md", "absolute"],
    [
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes/../main.md",
      "traversal",
    ],
    [
      "memory-bank/collaboration/other/round-1/agent_one/proposed_changes/main.md",
      "other workflow",
    ],
    [
      "memory-bank/collaboration/wf-test/round-2/agent_one/proposed_changes/main.md",
      "wrong round",
    ],
    [
      "memory-bank/collaboration/wf-test/round-1/agent_two/proposed_changes/main.md",
      "wrong agent",
    ],
    [
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes/main.txt",
      "wrong extension",
    ],
  ])("rejects %s as %s", async (badPath) => {
    const worktreePath = await tempWorktree();
    const result = await validateGeneratedArtifactFiles({
      worktreePath,
      workflowId: baseContext.workflowId,
      artifact: {
        kind: "proposed_changes",
        agent: "agent_one",
        target_agent: "agent_two",
        round: 1,
        summary: "Proposal.",
        artifacts: [artifactRef({ path: badPath })],
        accepted_from_other_agent_draft: [],
        proposed_changes: [],
        remaining_disagreements: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing generated file", async () => {
    const worktreePath = await tempWorktree();
    const result = await validateGeneratedArtifactFiles({
      worktreePath,
      workflowId: baseContext.workflowId,
      artifact: {
        kind: "proposed_changes",
        agent: "agent_one",
        target_agent: "agent_two",
        round: 1,
        summary: "Proposal.",
        artifacts: [artifactRef()],
        accepted_from_other_agent_draft: [],
        proposed_changes: [],
        remaining_disagreements: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty generated file", async () => {
    const worktreePath = await tempWorktree();
    const ref = artifactRef();
    await writeMarkdown(worktreePath, ref.path, "   \n");

    const result = await validateGeneratedArtifactFiles({
      worktreePath,
      workflowId: baseContext.workflowId,
      artifact: {
        kind: "proposed_changes",
        agent: "agent_one",
        target_agent: "agent_two",
        round: 1,
        summary: "Proposal.",
        artifacts: [ref],
        accepted_from_other_agent_draft: [],
        proposed_changes: [],
        remaining_disagreements: [],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects generated files over 512 KiB", async () => {
    const worktreePath = await tempWorktree();
    const ref = artifactRef();
    await writeMarkdown(worktreePath, ref.path, "x".repeat(512 * 1024 + 1));

    const result = await validateGeneratedArtifactFiles({
      worktreePath,
      workflowId: baseContext.workflowId,
      artifact: {
        kind: "proposed_changes",
        agent: "agent_one",
        target_agent: "agent_two",
        round: 1,
        summary: "Proposal.",
        artifacts: [ref],
        accepted_from_other_agent_draft: [],
        proposed_changes: [],
        remaining_disagreements: [],
      },
    });

    expect(result.success).toBe(false);
  });
});
