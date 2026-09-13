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

  it("accepts a supporting ref to an earlier phase's artifact in the same workflow alongside the phase's own main file", async () => {
    const worktreePath = await tempWorktree();
    const main = artifactRef();
    const earlierDraft = artifactRef({
      id: "initial-draft",
      artifact_type: "supporting",
      path: "memory-bank/collaboration/wf-test/round-0/agent_one/initial_draft/main.md",
      summary: "My round-0 draft, referenced by section number.",
    });
    await writeMarkdown(worktreePath, main.path);
    await writeMarkdown(worktreePath, earlierDraft.path, "# Draft\n\nBody");

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
          artifacts: [main, earlierDraft],
          accepted_from_other_agent_draft: [],
          proposed_changes: [],
          remaining_disagreements: [],
        },
      }),
    ).resolves.toEqual({ success: true, value: undefined });
  });

  it.each([
    ["/tmp/main.md", "absolute", "path must be relative"],
    [
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes/../main.md",
      "traversal",
      "path must not contain traversal segments",
    ],
    [
      "memory-bank/collaboration/other/round-1/agent_one/proposed_changes/main.md",
      "other workflow",
      "path must stay under memory-bank/collaboration/wf-test/",
    ],
    [
      "memory-bank/other-dir/wf-test/round-1/agent_one/proposed_changes/main.md",
      "outside the collaboration directory",
      "path must stay under memory-bank/collaboration/wf-test/",
    ],
    [
      "memory-bank/collaboration/wf-test/round-1/agent_one/proposed_changes/main.txt",
      "wrong extension",
      "path must end with .md",
    ],
  ])("rejects %s as %s", async (badPath, _label, expectedError) => {
    const worktreePath = await tempWorktree();
    // The file exists so the only possible rejection is the path rule itself.
    if (!path.posix.isAbsolute(badPath)) {
      await writeMarkdown(worktreePath, path.posix.normalize(badPath));
    }
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

    expect(result).toEqual({
      success: false,
      error: `${badPath}: ${expectedError}`,
    });
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
