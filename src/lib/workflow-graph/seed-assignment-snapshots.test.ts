import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { composeProfileBlock } from "@/lib/agent-profiles/composer";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { seedAssignmentSnapshots } from "./seed-assignment-snapshots";
import type { CascadeWorkflowSemanticDefinition } from "./definition-schemas";

const PROJECT_PATH = "/seed-snapshots-project";

const CLAUDE_AGENT = {
  backend: "claude",
  model: "sonnet",
  reasoningEffort: "medium",
} as const;

let tempDir: string;
let library: AgentProfileLibraryService;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-seed-snapshots-"));
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => tempDir }),
    // Deletion is a step here, not the subject: no workflow artifacts exist in
    // this fixture, so the reporter has nothing to find.
    referenceReporter: {
      async enumerateSavedReferences() {
        return { definitions: [], templates: [], workflowDefaults: false };
      },
    },
  });

  await library.create({
    projectPath: PROJECT_PATH,
    tier: "project",
    id: "repo-reviewer",
    name: "Repo Reviewer",
    description: "This repository's review lens",
    instructions: "Review against this repository's conventions.",
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function validator(
  id: string,
  profile: { tier: "builtin" | "global" | "project"; id: string },
  focus?: string,
) {
  return {
    id,
    profile,
    ...(focus === undefined ? {} : { focus }),
    strategy: "conversation" as const,
    agent: CLAUDE_AGENT,
    continuity: { enabled: true },
  };
}

function cascade(
  contextValidator: CascadeWorkflowSemanticDefinition["executionContexts"][number]["contextValidator"],
  implementerFocus?: string,
): CascadeWorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    laneMergeValidation: {
      strategy: "final-only",
      commands: { mode: "project" },
    },
    executionContexts: [
      {
        id: "ctx-1",
        title: "Build",
        acceptanceCriteria: "It builds",
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          ...(implementerFocus === undefined
            ? {}
            : { focus: implementerFocus }),
          agent: CLAUDE_AGENT,
        },
        contextValidator,
        scriptValidator: { commands: [] },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
        planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        charter: makeTestCharter(),
      },
    ],
    tasks: [],
    edges: [],
  };
}

describe("seedAssignmentSnapshots (R4)", () => {
  it("snapshots the implementer with all eight resolved fields", async () => {
    const seeded = await seedAssignmentSnapshots(
      cascade({
        enabled: true,
        assignments: [
          validator("general", { tier: "builtin", id: "general-reviewer" }),
        ],
      }),
      { library, projectPath: PROJECT_PATH },
    );

    const snapshot = seeded.executionContexts[0]?.implementer.profileSnapshot;
    expect(Object.keys(snapshot ?? {}).sort()).toEqual([
      "id",
      "instructions",
      "name",
      "renderedInstructionBlock",
      "resolvedInstructionHash",
      "revision",
      "sourceContentHash",
      "tier",
    ]);
    expect(snapshot?.tier).toBe("builtin");
    expect(snapshot?.id).toBe("general-implementer");
  });

  it("snapshots dormant assignments inside a disabled cohort", async () => {
    const seeded = await seedAssignmentSnapshots(
      cascade({
        enabled: false,
        assignments: [
          validator("dormant", { tier: "project", id: "repo-reviewer" }),
        ],
      }),
      { library, projectPath: PROJECT_PATH },
    );

    const cohort = seeded.executionContexts[0]?.contextValidator;
    expect(cohort?.enabled).toBe(false);
    expect(cohort?.assignments[0]?.profileSnapshot.id).toBe("repo-reviewer");
    expect(
      cohort?.assignments[0]?.profileSnapshot.renderedInstructionBlock,
    ).toContain("Review against this repository's conventions.");
  });

  it("renders each assignment's focus into its own snapshot block and hash", async () => {
    const seeded = await seedAssignmentSnapshots(
      cascade({
        enabled: true,
        assignments: [
          validator(
            "security",
            { tier: "project", id: "repo-reviewer" },
            "auth boundaries",
          ),
          validator(
            "performance",
            { tier: "project", id: "repo-reviewer" },
            "hot paths",
          ),
        ],
      }),
      { library, projectPath: PROJECT_PATH },
    );

    const [security, performance] =
      seeded.executionContexts[0]?.contextValidator.assignments ?? [];

    expect(security?.profileSnapshot.renderedInstructionBlock).toContain(
      "auth boundaries",
    );
    expect(performance?.profileSnapshot.renderedInstructionBlock).toContain(
      "hot paths",
    );
    // Same profile, same revision, same source hash — different delivered layer.
    expect(security?.profileSnapshot.sourceContentHash).toBe(
      performance?.profileSnapshot.sourceContentHash,
    );
    expect(security?.profileSnapshot.resolvedInstructionHash).not.toBe(
      performance?.profileSnapshot.resolvedInstructionHash,
    );
  });

  it("stores bytes a lane can replay verbatim", async () => {
    const resolved = await library.resolve(PROJECT_PATH, {
      tier: "project",
      id: "repo-reviewer",
    });
    const expected = composeProfileBlock(resolved, {
      assignmentFocus: "auth boundaries",
    });

    const seeded = await seedAssignmentSnapshots(
      cascade({
        enabled: true,
        assignments: [
          validator(
            "security",
            { tier: "project", id: "repo-reviewer" },
            "auth boundaries",
          ),
        ],
      }),
      { library, projectPath: PROJECT_PATH },
    );

    const snapshot =
      seeded.executionContexts[0]?.contextValidator.assignments[0]
        ?.profileSnapshot;
    expect(snapshot?.renderedInstructionBlock).toBe(expected.block);
    expect(snapshot?.resolvedInstructionHash).toBe(
      expected.resolvedInstructionHash,
    );
  });

  it("is immune to a later library edit — the seeded bytes do not move", async () => {
    const seeded = await seedAssignmentSnapshots(
      cascade({
        enabled: true,
        assignments: [
          validator("repo", { tier: "project", id: "repo-reviewer" }),
        ],
      }),
      { library, projectPath: PROJECT_PATH },
    );
    const before =
      seeded.executionContexts[0]?.contextValidator.assignments[0]
        ?.profileSnapshot;

    await library.update({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: "repo-reviewer" },
      expectedRevision: 1,
      content: {
        name: "Repo Reviewer",
        description: "This repository's review lens",
        instructions: "COMPLETELY DIFFERENT INSTRUCTIONS.",
      },
    });

    expect(before?.instructions).toBe(
      "Review against this repository's conventions.",
    );
    expect(before?.renderedInstructionBlock).not.toContain(
      "COMPLETELY DIFFERENT",
    );
    expect(before?.revision).toBe(1);
  });

  it("fails closed on a reference deleted between validate and seed", async () => {
    await library.delete({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: "repo-reviewer" },
      expectedRevision: 1,
      confirmed: true,
    });

    await expect(
      seedAssignmentSnapshots(
        cascade({
          enabled: true,
          assignments: [
            validator("repo", { tier: "project", id: "repo-reviewer" }),
          ],
        }),
        { library, projectPath: PROJECT_PATH },
      ),
    ).rejects.toThrow(/project:repo-reviewer/);
  });
});
