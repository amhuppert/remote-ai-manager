import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { createAssignmentReferenceChecker } from "./assignment-references";
import type { WorkflowSemanticDefinition } from "./definition-schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { AgentAssignment, ValidatorAssignment } from "./config-schemas";

const PROJECT_PATH = "/assignment-refs-project";

let tempDir: string;
let checker: ReturnType<typeof createAssignmentReferenceChecker>;

const CLAUDE_AGENT = {
  backend: "claude",
  modelSelection: {
    modelId: "sonnet",
    parameters: { effort: "medium" },
  },
} as const;

/**
 * A REAL library over a temp config dir — the checker's whole job is deciding
 * which references resolve, so answering that from a stub would leave the
 * production question (does the library find it, in this tier, from this
 * project) untested.
 */
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-assignment-refs-"));
  const library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => tempDir }),
  });

  await library.create({
    projectPath: PROJECT_PATH,
    tier: "global",
    id: "org-reviewer",
    name: "Org Reviewer",
    description: "The org-wide review lens",
    instructions: "Review against the org standards.",
  });
  await library.create({
    projectPath: PROJECT_PATH,
    tier: "project",
    id: "repo-reviewer",
    name: "Repo Reviewer",
    description: "This repository's review lens",
    instructions: "Review against this repository's conventions.",
  });

  checker = createAssignmentReferenceChecker({ library });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function assignment(profile: AgentProfileRef): AgentAssignment {
  return {
    id: "implementer",
    profile,
    agent: CLAUDE_AGENT,
  };
}

function validator(id: string, profile: AgentProfileRef): ValidatorAssignment {
  return {
    id,
    profile,
    strategy: "conversation",
    authority: "advisory",
    agent: CLAUDE_AGENT,
  };
}

function definition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Build",
        acceptanceCriteria: "It builds",
      },
    ],
    tasks: [],
    edges: [],
    ...overrides,
  } as WorkflowSemanticDefinition;
}

describe("assignment reference checker — project scope (R4.2)", () => {
  it("accepts a project definition referencing builtin, global, and project tiers", async () => {
    const issues = await checker.checkDefinition(
      definition({
        workflowConfig: {
          implementer: assignment({
            tier: "builtin",
            id: "general-implementer",
          }),
          contextValidator: {
            enabled: true,
            assignments: [
              validator("org", { tier: "global", id: "org-reviewer" }),
              validator("repo", { tier: "project", id: "repo-reviewer" }),
            ],
          },
        },
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "project", projectPath: PROJECT_PATH },
    );

    expect(issues).toEqual([]);
  });

  it("refuses a dangling reference, naming the qualified ref and the use site", async () => {
    const issues = await checker.checkDefinition(
      definition({
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build",
            acceptanceCriteria: "It builds",
            contextValidator: {
              enabled: true,
              assignments: [
                validator("security", {
                  tier: "project",
                  id: "ghost-reviewer",
                }),
              ],
            },
          },
        ],
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "project", projectPath: PROJECT_PATH },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(
      "definition.executionContexts.0.contextValidator.assignments.0.profile",
    );
    expect(issues[0]?.message).toContain("project:ghost-reviewer");
    expect(issues[0]?.message).toContain("security");
  });

  it("checks dormant assignments inside a disabled cohort", async () => {
    const issues = await checker.checkDefinition(
      definition({
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build",
            acceptanceCriteria: "It builds",
            contextValidator: {
              enabled: false,
              assignments: [
                validator("dormant", { tier: "global", id: "ghost-reviewer" }),
              ],
            },
          },
        ],
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "project", projectPath: PROJECT_PATH },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("global:ghost-reviewer");
  });

  it("reports every dangling reference rather than stopping at the first", async () => {
    const issues = await checker.checkDefinition(
      definition({
        workflowConfig: {
          implementer: assignment({ tier: "global", id: "ghost-one" }),
        },
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build",
            acceptanceCriteria: "It builds",
            implementer: assignment({ tier: "project", id: "ghost-two" }),
          },
        ],
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "project", projectPath: PROJECT_PATH },
    );

    expect(issues.map((issue) => issue.path)).toEqual([
      "definition.workflowConfig.implementer.profile",
      "definition.executionContexts.0.implementer.profile",
    ]);
  });
});

describe("assignment reference checker — global scope rule (R4.2)", () => {
  it("refuses a project-tier reference in a global template, naming the scope rule", async () => {
    const issues = await checker.checkDefinition(
      definition({
        workflowConfig: {
          contextValidator: {
            enabled: true,
            assignments: [
              validator("repo", { tier: "project", id: "repo-reviewer" }),
            ],
          },
        },
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "global" },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(
      "definition.workflowConfig.contextValidator.assignments.0.profile",
    );
    expect(issues[0]?.message).toContain("project:repo-reviewer");
    expect(issues[0]?.message).toMatch(/global/i);
    expect(issues[0]?.message).toMatch(/project-tier/i);
  });

  it("refuses a project-tier reference even when that profile exists in some project", async () => {
    // `project:repo-reviewer` genuinely exists under PROJECT_PATH. The scope
    // rule is about reachability from a global document, not existence.
    const issues = await checker.checkDefinition(
      definition({
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build",
            acceptanceCriteria: "It builds",
            implementer: assignment({ tier: "project", id: "repo-reviewer" }),
          },
        ],
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "global" },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/project-tier/i);
  });

  it("accepts builtin and global tiers in a global document", async () => {
    const issues = await checker.checkDefinition(
      definition({
        workflowConfig: {
          implementer: assignment({
            tier: "builtin",
            id: "general-implementer",
          }),
          contextValidator: {
            enabled: true,
            assignments: [
              validator("org", { tier: "global", id: "org-reviewer" }),
            ],
          },
        },
      } as Partial<WorkflowSemanticDefinition>),
      { kind: "global" },
    );

    expect(issues).toEqual([]);
  });
});

describe("assignment reference checker — global workflow defaults (R4.2)", () => {
  const defaults = (
    overrides: Record<string, unknown>,
  ): Partial<WorkflowDefaults> => overrides as Partial<WorkflowDefaults>;

  it("refuses a project-tier reference in global workflowDefaults", async () => {
    const issues = await checker.checkWorkflowDefaults(
      defaults({
        implementer: assignment({ tier: "project", id: "repo-reviewer" }),
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("workflowDefaults.implementer.profile");
    expect(issues[0]?.message).toMatch(/project-tier/i);
  });

  it("refuses a dangling global-tier reference in global workflowDefaults", async () => {
    const issues = await checker.checkWorkflowDefaults(
      defaults({
        contextValidator: {
          enabled: true,
          assignments: [validator("org", { tier: "global", id: "ghost" })],
        },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(
      "workflowDefaults.contextValidator.assignments.0.profile",
    );
    expect(issues[0]?.message).toContain("global:ghost");
  });

  it("accepts builtin and global references in global workflowDefaults", async () => {
    const issues = await checker.checkWorkflowDefaults(
      defaults({
        implementer: assignment({ tier: "builtin", id: "general-implementer" }),
        contextValidator: {
          enabled: true,
          assignments: [
            validator("org", { tier: "global", id: "org-reviewer" }),
          ],
        },
      }),
    );

    expect(issues).toEqual([]);
  });

  it("reports nothing when workflowDefaults declares no assignments", async () => {
    expect(await checker.checkWorkflowDefaults(undefined)).toEqual([]);
    expect(await checker.checkWorkflowDefaults(defaults({}))).toEqual([]);
  });
});
