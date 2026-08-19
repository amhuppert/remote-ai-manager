import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
  makeValidatorAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { createAssignmentReferenceChecker } from "./assignment-references";
import { createGraphWorkflowValidateHandlers } from "./validate-route-handlers";

function makeRequest(
  body?: unknown,
  token = "good-token",
  query = "",
): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/repo/sessions/sess/graph-workflow/validate${query}`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    },
  );
}

function makeContext() {
  return { params: Promise.resolve({ name: "repo", session: "sess" }) };
}

function makePlan(definition = createWorkflowDefinition()) {
  return {
    name: "Test Workflow",
    description: "A workflow under test",
    definition,
    layout: createWorkflowLayout(),
  };
}

/** Auth that accepts only the exact bearer token, mirroring the real gate. */
function tokenAuth(expected: string): AgentAuth {
  return {
    async requireToken(request: Request): Promise<Response | null> {
      const header = request.headers.get("authorization");
      if (header === `Bearer ${expected}`) return null;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    },
    async validateOptionalToken(request: Request) {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" as const };
      if (header === `Bearer ${expected}`) return { kind: "valid" as const };
      return { kind: "invalid" as const };
    },
  };
}

describe("graph-workflow validate route handler", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const getSession =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<{ sessionName: string } | null>
    >();
  const readRepoConfig =
    vi.fn<(_projectPath: string) => Promise<PerRepoConfig | null>>();
  const readConfig = vi.fn<() => Promise<GlobalConfig>>();

  let profileDir: string;
  let handlers: ReturnType<typeof createGraphWorkflowValidateHandlers>;

  beforeEach(async () => {
    vi.resetAllMocks();
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue({ sessionName: "sess" });
    readRepoConfig.mockResolvedValue(null);
    readConfig.mockResolvedValue({
      validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
    } as GlobalConfig);

    profileDir = await mkdtemp(path.join(tmpdir(), "cc-validate-profiles-"));
    handlers = createGraphWorkflowValidateHandlers({
      auth: tokenAuth("good-token"),
      resolveProjectPath,
      getSession,
      readRepoConfig,
      readConfig,
      assignmentReferences: createAssignmentReferenceChecker({
        library: createAgentProfileLibraryService({
          storage: createAgentProfileStorage({
            resolveConfigDir: () => profileDir,
          }),
        }),
      }),
    });
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  it("returns 400 naming the dangling qualified ref and its use site", async () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context, index) =>
        index === 0
          ? {
              ...context,
              contextValidator: {
                enabled: true,
                assignments: [
                  {
                    id: "security",
                    profile: { tier: "global" as const, id: "never-created" },
                    strategy: "conversation" as const,
                    authority: "blocking" as const,
                    agent: {
                      backend: "claude" as const,
                      model: "sonnet" as const,
                      reasoningEffort: "medium" as const,
                    },
                    continuity: { enabled: true },
                  },
                ],
              },
            }
          : context,
      ),
    };

    const response = await handlers.POST(
      makeRequest(makePlan(definition)),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues: { path: string; message: string }[];
    };
    expect(body.issues.map((issue) => issue.path)).toContain(
      "definition.executionContexts.0.contextValidator.assignments.0.profile",
    );
    expect(body.issues[0]?.message).toContain("global:never-created");
    expect(body.issues[0]?.message).toContain("security");
  });

  /**
   * A plan can be flawless and still be unlaunchable, because the cascade
   * staffs it from `workflowDefaults` the plan never mentions. Validate is the
   * pre-flight for a launch, so it has to answer the question the launch will
   * actually ask — and locate the answer in the config field to fix, not in the
   * plan, which is innocent.
   */
  it("returns 400 located at workflowDefaults when the inherited defaults reference a deleted profile", async () => {
    const handlersWithDefaults = createGraphWorkflowValidateHandlers({
      auth: tokenAuth("good-token"),
      resolveProjectPath,
      getSession,
      readRepoConfig,
      assignmentReferences: createAssignmentReferenceChecker({
        library: createAgentProfileLibraryService({
          storage: createAgentProfileStorage({
            resolveConfigDir: () => profileDir,
          }),
        }),
      }),
      readConfig: async () =>
        ({
          workflowDefaults: {
            contextValidator: {
              enabled: true,
              assignments: [
                makeValidatorAssignment({
                  id: "house",
                  profile: { tier: "global", id: "since-deleted" },
                }),
              ],
            },
          },
        }) as GlobalConfig,
    });

    // The plan itself authors no validator at all — every reference to the
    // missing profile arrives through the cascade.
    const response = await handlersWithDefaults.POST(
      makeRequest(makePlan()),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues: { path: string; message: string }[];
    };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.path).toBe(
      "workflowDefaults.contextValidator.assignments.0.profile",
    );
    expect(body.issues[0]?.message).toContain("global:since-deleted");
    expect(body.issues[0]?.message).toContain("global-defaults");
  });

  it("returns { ok: true } for a well-formed plan", async () => {
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(200);
    // `ok` and the absence of issues are the verdict. Advisory warnings may
    // ride along — the fixture charter's locators do not resolve under the
    // stub project path, which the semantic lints report (#69 change 6) — and
    // by construction they never change the verdict.
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(body).not.toHaveProperty("issues");
  });

  it("returns the guard enum-coverage warnings alongside ok (R3.2)", async () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["ship", "hold"] },
                },
                required: ["verdict"],
              },
            }
          : context,
      ),
      edges: base.edges.map((edge) =>
        edge.sourceContextId === "context-plan"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { const: "ship" } },
                  required: ["verdict"],
                },
              },
            }
          : edge,
      ),
    };

    const response = await handlers.POST(
      makeRequest(makePlan(definition)),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        {
          path: "definition.executionContexts[0].outputSchema.properties.verdict.enum",
          message: expect.stringContaining('"hold"'),
        },
      ]),
    });
  });

  it("returns the semantic authoring lints alongside ok (#69 change 6)", async () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              acceptanceCriteria: [
                { id: "ac-sweep", statement: "Every call site is migrated" },
              ],
            }
          : context,
      ),
    };

    const response = await handlers.POST(
      makeRequest(makePlan(definition)),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        {
          path: "definition.executionContexts.0.acceptanceCriteria.0.statement",
          message: expect.stringContaining("lint/open-quantifier"),
        },
        {
          // The stub project path has no worktree behind it, so every charter
          // locator is unresolvable — the incident this lint pins.
          path: "definition.charter.sourcesOfTruth.0.locator",
          message: expect.stringContaining("lint/source-locator-unresolvable"),
        },
      ]),
    });
    expect(body).not.toHaveProperty("issues");
  });

  it("skips the locator lint for a global-scope template", async () => {
    const response = await handlers.POST(
      makeRequest(makePlan(), "good-token", "?tier=global"),
      makeContext(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      warnings?: { message: string }[];
    };
    expect(body.ok).toBe(true);
    expect(
      (body.warnings ?? []).filter((warning) =>
        warning.message.startsWith("lint/source-locator-unresolvable"),
      ),
    ).toEqual([]);
  });

  it("rejects a missing/invalid token with 401", async () => {
    const response = await handlers.POST(
      makeRequest(makePlan(), "wrong-token"),
      makeContext(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    resolveProjectPath.mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session cannot be resolved", async () => {
    getSession.mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 with JSON-path issues for a cyclic graph", async () => {
    const definition = createWorkflowDefinition();
    const cyclic = {
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: "edge-verify-plan",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
      ],
    };

    const response = await handlers.POST(
      makeRequest(makePlan(cyclic)),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error.length).toBeGreaterThan(0);
    const paths = body.issues.map((i) => i.path);
    expect(paths).toContain("definition.edges");
  });

  it("returns 400 with path-qualified issues for unknown validation commands", async () => {
    readRepoConfig.mockResolvedValue({
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck"],
      },
    });

    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "ghost"] },
        agentValidation: {
          implementer: { mode: "all", except: ["phantom"] },
        },
      },
    });

    const response = await handlers.POST(
      makeRequest(makePlan(definition)),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues: { path: string; message: string }[];
    };
    expect(body.issues).toEqual([
      expect.objectContaining({
        path: "definition.workflowConfig.scriptValidator.commands.1",
        message: expect.stringContaining('Unknown validation command "ghost"'),
      }),
      expect.objectContaining({
        path: "definition.workflowConfig.agentValidation.implementer.except.0",
        message: expect.stringContaining(
          'Unknown validation command "phantom"',
        ),
      }),
    ]);
  });

  it("rejects the same oversized selection that create rejects", async () => {
    readRepoConfig.mockResolvedValue({
      validation: {
        commands: {
          test: {
            command: {
              full: "scripts/validate/test-full-suite.sh",
              changed: "scripts/validate/test.sh",
            },
            cost: 5,
            pathArgs: "paths",
          },
        },
        preMerge: ["test"],
      },
    });
    readConfig.mockResolvedValue({
      validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
    } as GlobalConfig);
    const definition = createWorkflowDefinition({
      workflowConfig: { scriptValidator: { commands: ["test"] } },
    });

    const response = await handlers.POST(
      makeRequest(makePlan(definition)),
      makeContext(),
    );

    expect(response.status).toBe(400);
    const responseBody = (await response.json()) as {
      code?: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(responseBody.code).toBe("validation_cost_exceeds_limit");
    expect(responseBody.issues).toContainEqual(
      expect.objectContaining({
        path: "definition.workflowConfig.scriptValidator.commands.0",
        message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
      }),
    );
  });

  // R4.2: validate is the pre-flight for a save, so it has to be held to the
  // scope the plan is destined for. Without a scope selector a plan authored as
  // a global template validates under project rules and only fails later, at
  // save — the exact "passes validate, refused at save" split R4.2 forbids.
  describe("document scope selector (R4.2)", () => {
    /** A project-tier profile that genuinely resolves under /repo. */
    async function seedProjectProfile(): Promise<void> {
      await createAgentProfileLibraryService({
        storage: createAgentProfileStorage({
          resolveConfigDir: () => profileDir,
        }),
      }).create({
        projectPath: "/repo",
        tier: "project",
        id: "repo-reviewer",
        name: "Repo Reviewer",
        description: "This repository's review lens",
        instructions: "Review against this repository's conventions.",
      });
    }

    function planReferencingProjectTier() {
      const base = createWorkflowDefinition();
      return makePlan({
        ...base,
        executionContexts: base.executionContexts.map((context, index) =>
          index === 0
            ? {
                ...context,
                contextValidator: {
                  enabled: true,
                  assignments: [
                    {
                      id: "repo",
                      profile: {
                        tier: "project" as const,
                        id: "repo-reviewer",
                      },
                      strategy: "conversation" as const,
                      authority: "blocking",
                      agent: {
                        backend: "claude" as const,
                        model: "sonnet" as const,
                        reasoningEffort: "medium" as const,
                      },
                      continuity: { enabled: true },
                    },
                  ],
                },
              }
            : context,
        ),
      });
    }

    it("refuses a project-tier reference under ?tier=global, naming the scope rule", async () => {
      await seedProjectProfile();

      const response = await handlers.POST(
        makeRequest(planReferencingProjectTier(), "good-token", "?tier=global"),
        makeContext(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        issues: { path: string; message: string }[];
      };
      expect(body.issues.map((issue) => issue.path)).toContain(
        "definition.executionContexts.0.contextValidator.assignments.0.profile",
      );
      expect(body.issues[0]?.message).toMatch(/project-tier/i);
      expect(body.issues[0]?.message).toContain("project:repo-reviewer");
    });

    it("accepts the same project-tier reference under the default project scope", async () => {
      await seedProjectProfile();

      const response = await handlers.POST(
        makeRequest(planReferencingProjectTier()),
        makeContext(),
      );

      expect(response.status).toBe(200);
    });

    it("accepts a builtin-tier plan under ?tier=global", async () => {
      const response = await handlers.POST(
        makeRequest(makePlan(), "good-token", "?tier=global"),
        makeContext(),
      );

      expect(response.status).toBe(200);
    });

    it("rejects an unknown tier value rather than silently validating as project", async () => {
      const response = await handlers.POST(
        makeRequest(makePlan(), "good-token", "?tier=bogus"),
        makeContext(),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/tier/i);
    });
  });

  it("returns 400 when the body is not JSON", async () => {
    const request = new NextRequest(
      "http://localhost/api/projects/repo/sessions/sess/graph-workflow/validate",
      {
        method: "POST",
        body: "not json",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer good-token",
        },
      },
    );
    const response = await handlers.POST(request, makeContext());
    expect(response.status).toBe(400);
  });
});

describe("graph-workflow validate persists nothing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-validate-persist-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes no workflow definition when validating a valid plan", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const scope = { kind: "project" as const, projectPath: "/repo" };

    expect(await storage.list(scope)).toHaveLength(0);

    const handlers = createGraphWorkflowValidateHandlers({
      auth: tokenAuth("good-token"),
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({ sessionName: "sess" }),
      readRepoConfig: async () => null,
      readConfig: async () =>
        ({
          validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
        }) as GlobalConfig,
      assignmentReferences: createAssignmentReferenceChecker({
        library: createAgentProfileLibraryService({
          storage: createAgentProfileStorage({
            resolveConfigDir: () => tempDir,
          }),
        }),
      }),
    });

    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(200);

    // The validate endpoint has no persistence path; nothing is stored.
    expect(await storage.list(scope)).toHaveLength(0);
  });
});
