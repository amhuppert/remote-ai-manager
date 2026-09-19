import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
  makeValidatorAssignment,
  TEST_AGENT_BACKENDS_CONFIG,
} from "@/lib/workflow-graph/test-fixtures";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { buildChildEnv } from "@/lib/shared/child-env";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import { createAssignmentReferenceChecker } from "./assignment-references";
import { SEEDED_WORKFLOW_DEFAULTS } from "./resolve-config";
import type { ManagedDefinitionPreflightPort } from "./managed-definition-preflight";
import { createGraphWorkflowValidateHandlers } from "./validate-route-handlers";

const execFileAsync = promisify(execFile);

function makeRequest(
  body?: unknown,
  token = "good-token",
  query = "",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/repo/sessions/sess/graph-workflow/validate${query}`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
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

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: TEST_AGENT_BACKENDS_CONFIG,
    defaultAgentBackend: "claude",
    ...overrides,
  };
}

function makePlanWithSource(sourceId: string, locator: string) {
  const definition = createWorkflowDefinition();
  const source = definition.charter.sourcesOfTruth[0]!;
  return makePlan({
    ...definition,
    charter: {
      ...definition.charter,
      sourcesOfTruth: [{ ...source, id: sourceId, locator }],
    },
  });
}

async function createCommittedRepo(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<{ path: string; sha: string }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), prefix));
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoPath, relativePath)), {
      recursive: true,
    });
    await writeFile(path.join(repoPath, relativePath), contents);
  }
  await git(["add", "-A"]);
  await git(["commit", "-m", "source fixtures", "--no-verify"]);
  return { path: repoPath, sha: (await git(["rev-parse", "HEAD"])).trim() };
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
  const getSession = vi.fn<
    (
      _projectPath: string,
      _sessionName: string,
    ) => Promise<{
      sessionName: string;
      branchName: string;
      worktreePath: string;
    } | null>
  >();
  const readRepoConfig =
    vi.fn<(_projectPath: string) => Promise<PerRepoConfig | null>>();
  const readConfig = vi.fn<() => Promise<GlobalConfig>>();
  const preflightManagedDefinition =
    vi.fn<ManagedDefinitionPreflightPort["preflight"]>();

  let profileDir: string;
  let handlers: ReturnType<typeof createGraphWorkflowValidateHandlers>;
  let routeLog: CapturingLogger;

  beforeEach(async () => {
    vi.resetAllMocks();
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue({
      sessionName: "sess",
      branchName: "csm/sess",
      worktreePath: "/session-worktree",
    });
    readRepoConfig.mockResolvedValue(null);
    readConfig.mockResolvedValue(
      makeGlobalConfig({
        validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
      }),
    );
    preflightManagedDefinition.mockResolvedValue({
      ok: true,
      specSlug: "delivery-plan",
      findings: [],
      summary: {
        selected: 0,
        claimed: 0,
        unclaimed: 0,
        dispositions: [],
        charter: {
          state: "authored",
          invariantCount: 0,
          sourceCount: 1,
        },
      },
    });
    routeLog = createCapturingLogger();

    profileDir = await mkdtemp(path.join(tmpdir(), "cc-validate-profiles-"));
    handlers = createGraphWorkflowValidateHandlers({
      auth: tokenAuth("good-token"),
      resolveProjectPath,
      getSession,
      readRepoConfig,
      readConfig,
      log: routeLog,
      assignmentReferences: createAssignmentReferenceChecker({
        library: createAgentProfileLibraryService({
          storage: createAgentProfileStorage({
            resolveConfigDir: () => profileDir,
          }),
        }),
      }),
      managedDefinitionPreflight: {
        preflight: preflightManagedDefinition,
      },
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
                    authority: "blocking" as const,
                    agent: {
                      backend: "claude" as const,
                      modelSelection: {
                        modelId: "sonnet",
                        parameters: { effort: "medium" },
                      },
                    },
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
      "definition.executionContexts.0 (context-plan).contextValidator.assignments.0 (security).profile",
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
        makeGlobalConfig({
          workflowDefaults: {
            ...SEEDED_WORKFLOW_DEFAULTS,
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
        }),
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

  it("runs the managed definition preflight against the admitted submitted plan", async () => {
    preflightManagedDefinition.mockResolvedValue({
      ok: true,
      specSlug: "delivery-plan",
      findings: [
        {
          ruleId: "binding/selected-criterion-unclaimed",
          severity: "blocks_propose",
          elementHandle: "R1.1",
          message: "Selected criterion R1.1 has no accountability claim.",
        },
        {
          ruleId: "launch/advisory",
          severity: "advisory",
          elementHandle: "context-verify",
          message: "The verification context carries broad prose.",
          recordId: "context-verify",
        },
      ],
      summary: {
        selected: 2,
        claimed: 1,
        unclaimed: 1,
        dispositions: [{ kind: "in_scope", count: 2 }],
        charter: {
          state: "authored",
          invariantCount: 1,
          sourceCount: 2,
        },
      },
    });
    const plan = makePlan();

    const response = await handlers.POST(
      makeRequest(plan, "good-token", "?definition=managed-wf"),
      makeContext(),
    );

    expect(response.status).toBe(200);
    expect(preflightManagedDefinition).toHaveBeenCalledWith({
      projectPath: "/repo",
      workflowDefinitionId: "managed-wf",
      launch: expect.objectContaining({ name: plan.name }),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      preflight: {
        specSlug: "delivery-plan",
        findings: [
          expect.objectContaining({
            ruleId: "binding/selected-criterion-unclaimed",
            severity: "blocks_propose",
            elementHandle: "R1.1",
          }),
          expect.objectContaining({
            ruleId: "launch/advisory",
            severity: "advisory",
            recordId: "context-verify",
          }),
        ],
        summary: expect.objectContaining({
          selected: 2,
          claimed: 1,
          unclaimed: 1,
        }),
      },
    });
  });

  it("keeps structural record ids and paths ahead of the managed preflight", async () => {
    const base = createWorkflowDefinition();
    const firstTask = base.tasks[0];
    if (firstTask === undefined) throw new Error("fixture has no task");
    const definition = {
      ...base,
      tasks: base.tasks.map((task, index) =>
        index === 0 ? { ...task, contextId: "missing-context" } : task,
      ),
    };

    const response = await handlers.POST(
      makeRequest(makePlan(definition), "good-token", "?definition=managed-wf"),
      makeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: expect.arrayContaining([
        {
          path: `definition.tasks.0 (${firstTask.id}).contextId`,
          message: expect.stringContaining("missing-context"),
          recordId: firstTask.id,
        },
      ]),
    });
    expect(preflightManagedDefinition).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an unmanaged definition",
      refusal: {
        code: "definition_not_managed" as const,
        message:
          "Workflow definition ordinary-wf is not managed by a spec delivery plan.",
        instruction:
          "Read the managed draft with `cctl spec plan status <slug>` and use the workflow definition id it names.",
      },
      instruction: "cctl spec plan status <slug>",
    },
    {
      label: "another project's definition",
      refusal: {
        code: "definition_project_mismatch" as const,
        message: "Workflow definition foreign-wf belongs to another project.",
        instruction:
          "Switch to that project and run `cctl spec plan status delivery-plan`.",
      },
      instruction: "cctl spec plan status delivery-plan",
    },
    {
      label: "a non-draft attempt",
      refusal: {
        code: "delivery_plan_not_draft" as const,
        message: "Delivery plan delivery-plan is proposed, not draft.",
        instruction:
          "Run `cctl spec plan reopen delivery-plan --reason <why>` before validating replacement bytes.",
        rationale:
          "the signed candidate is immutable so sign-off approves exact bytes",
      },
      instruction: "cctl spec plan reopen delivery-plan",
    },
  ])("returns a typed refusal for $label", async ({ refusal, instruction }) => {
    preflightManagedDefinition.mockResolvedValue({ ok: false, refusal });

    const response = await handlers.POST(
      makeRequest(makePlan(), "good-token", "?definition=managed-wf"),
      makeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: refusal.code,
      instruction: expect.stringContaining(instruction),
    });
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
          path: "definition.executionContexts[0] (context-plan).outputSchema.properties.verdict.enum",
          recordId: "context-plan",
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
          path: "definition.executionContexts.0 (context-plan).acceptanceCriteria.0 (ac-sweep).statement",
          message: expect.stringContaining("lint/open-quantifier"),
          recordId: "ac-sweep",
        },
      ]),
    });
    expect(body).not.toHaveProperty("issues");
  });

  it("does not report a source missing from the canonical checkout when the verified session HEAD contains it", async () => {
    const projectRepo = await createCommittedRepo("cc-project-source-", {
      "README.md": "# canonical checkout\n",
    });
    const sessionRepo = await createCommittedRepo("cc-session-source-", {
      "docs/session-design.md": "# session design\n",
    });
    resolveProjectPath.mockResolvedValue(projectRepo.path);
    getSession.mockResolvedValue({
      sessionName: "sess",
      branchName: "csm/session-design",
      worktreePath: sessionRepo.path,
    });

    try {
      const response = await handlers.POST(
        makeRequest(
          makePlanWithSource("session-design", "docs/session-design.md"),
        ),
        makeContext(),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        warnings?: { message: string }[];
      };
      expect(
        (body.warnings ?? []).filter((warning) =>
          warning.message.startsWith("lint/source-locator-unresolvable"),
        ),
      ).toEqual([]);
    } finally {
      await Promise.all([
        rm(projectRepo.path, { recursive: true, force: true }),
        rm(sessionRepo.path, { recursive: true, force: true }),
      ]);
    }
  });

  it.each([
    { scope: "project", query: "" },
    { scope: "global", query: "?tier=global" },
  ])(
    "reports a source absent from the verified session HEAD for $scope validation even when the canonical checkout contains it",
    async ({ query }) => {
      const projectRepo = await createCommittedRepo("cc-project-source-", {
        "docs/canonical-only.md": "# canonical-only design\n",
      });
      const sessionRepo = await createCommittedRepo("cc-session-source-", {
        "README.md": "# session checkout\n",
      });
      const sessionBranch = "csm/missing-session-source";
      resolveProjectPath.mockResolvedValue(projectRepo.path);
      getSession.mockResolvedValue({
        sessionName: "sess",
        branchName: sessionBranch,
        worktreePath: sessionRepo.path,
      });

      try {
        const response = await handlers.POST(
          makeRequest(
            makePlanWithSource("canonical-only", "docs/canonical-only.md"),
            "good-token",
            query,
          ),
          makeContext(),
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          warnings?: { path: string; message: string }[];
        };
        expect(body.warnings).toContainEqual({
          path: "definition.charter.sourcesOfTruth.0 (canonical-only).locator",
          recordId: "canonical-only",
          message: expect.stringMatching(
            new RegExp(
              `^lint/source-locator-unresolvable: .*branch "${sessionBranch}" at commit ${sessionRepo.sha}`,
            ),
          ),
        });
        const successLog = routeLog.entries
          .filter((entry) => entry.message === "graph-workflow-validate.ok")
          .at(-1);
        expect(successLog?.fields).toMatchObject({
          sourceResolutionKind: "session-commit",
          warningCount: body.warnings?.length,
        });
        expect(routeLog.allFieldValues()).not.toContain(
          "# canonical-only design\n",
        );
        expect(routeLog.allFieldValues()).not.toContain("good-token");
      } finally {
        await Promise.all([
          rm(projectRepo.path, { recursive: true, force: true }),
          rm(sessionRepo.path, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("merges lexical and committed source warnings in charter definition order before oversized prose", async () => {
    const projectRepo = await createCommittedRepo("cc-project-source-", {
      "docs/first.md": "# canonical first\n",
      "docs/last.md": "# canonical last\n",
    });
    const sessionRepo = await createCommittedRepo("cc-session-source-", {
      "README.md": "# session checkout\n",
    });
    resolveProjectPath.mockResolvedValue(projectRepo.path);
    getSession.mockResolvedValue({
      sessionName: "sess",
      branchName: "csm/source-order",
      worktreePath: sessionRepo.path,
    });
    const definition = createWorkflowDefinition();
    const firstSource = definition.charter.sourcesOfTruth[0]!;
    const secondSource = definition.charter.sourcesOfTruth[1]!;
    const plan = makePlan({
      ...definition,
      charter: {
        ...definition.charter,
        sourcesOfTruth: [
          { ...firstSource, rank: 1, id: "first", locator: "docs/first.md" },
          {
            ...secondSource,
            rank: 2,
            id: "invalid-shape",
            locator: "https://example.test/design",
          },
          { ...firstSource, rank: 3, id: "last", locator: "docs/last.md" },
        ],
      },
      tasks: definition.tasks.map((task, index) =>
        index === 0 ? { ...task, instructions: "i".repeat(8001) } : task,
      ),
    });

    try {
      const response = await handlers.POST(makeRequest(plan), makeContext());

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        warnings: { path: string; message: string }[];
      };
      const sourceWarningPaths = body.warnings
        .filter((warning) =>
          warning.message.startsWith("lint/source-locator-unresolvable"),
        )
        .map((warning) => warning.path);
      expect(sourceWarningPaths).toEqual([
        "definition.charter.sourcesOfTruth.0 (first).locator",
        "definition.charter.sourcesOfTruth.1 (invalid-shape).locator",
        "definition.charter.sourcesOfTruth.2 (last).locator",
      ]);
      expect(
        body.warnings.findIndex((warning) =>
          warning.message.startsWith("lint/source-locator-unresolvable"),
        ),
      ).toBeLessThan(
        body.warnings.findIndex((warning) =>
          warning.message.startsWith("lint/oversized-prose"),
        ),
      );
    } finally {
      await Promise.all([
        rm(projectRepo.path, { recursive: true, force: true }),
        rm(sessionRepo.path, { recursive: true, force: true }),
      ]);
    }
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
    readConfig.mockResolvedValue(
      makeGlobalConfig({
        validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
      }),
    );
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
  // #80 design 3.10: planning-phase friction has to leave telemetry, or the
  // next retrospective can count planning cost only by tallying tool calls in
  // a transcript.
  describe("planning telemetry", () => {
    function refusedEvents() {
      return routeLog.entries.filter(
        (entry) => entry.message === "workflow.validate.refused",
      );
    }

    /**
     * This route has no `conversationId` path segment, so the ambient trace
     * has none to derive: the refusal can only be attributed to the planning
     * conversation the calling shell names on the header.
     */
    function unresolvableAssignmentPlan() {
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
                      id: "security",
                      profile: {
                        tier: "global" as const,
                        id: "never-created",
                      },
                      authority: "blocking" as const,
                      agent: {
                        backend: "claude" as const,
                        modelSelection: {
                          modelId: "sonnet",
                          parameters: { effort: "medium" },
                        },
                      },
                    },
                  ],
                },
              }
            : context,
        ),
      });
    }

    it("emits workflow.validate.refused at info once per issue code, naming the caller's conversation", async () => {
      const response = await handlers.POST(
        makeRequest(unresolvableAssignmentPlan(), "good-token", "", {
          "x-cc-conversation-id": "conv-planner",
        }),
        makeContext(),
      );

      expect(response.status).toBe(400);
      expect(refusedEvents()).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "workflow_assignment_reference_invalid",
            recordId: "security",
            conversationId: "conv-planner",
          },
        },
      ]);
    });

    it("records a null conversation rather than dropping the field for a caller with none", async () => {
      const response = await handlers.POST(
        makeRequest(unresolvableAssignmentPlan()),
        makeContext(),
      );

      expect(response.status).toBe(400);
      expect(refusedEvents()[0]?.fields).toEqual({
        code: "workflow_assignment_reference_invalid",
        recordId: "security",
        conversationId: null,
      });
    });

    it("emits nothing when the plan validates", async () => {
      const response = await handlers.POST(
        makeRequest(makePlan()),
        makeContext(),
      );

      expect(response.status).toBe(200);
      expect(refusedEvents()).toEqual([]);
    });

    it("names the addressed definition when a managed preflight refuses", async () => {
      preflightManagedDefinition.mockResolvedValue({
        ok: false,
        refusal: {
          code: "definition_not_managed",
          message: "Workflow definition workflow-1 is not managed.",
          instruction: "Run `cctl spec plan status <slug>`.",
        },
      });

      const response = await handlers.POST(
        makeRequest(makePlan(), "good-token", "?definition=workflow-1", {
          "x-cc-conversation-id": "conv-planner",
        }),
        makeContext(),
      );

      expect(response.status).toBe(409);
      expect(refusedEvents()).toEqual([
        {
          level: "info",
          message: "workflow.validate.refused",
          fields: {
            code: "definition_not_managed",
            definitionId: "workflow-1",
            conversationId: "conv-planner",
          },
        },
      ]);
    });
  });

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
                      authority: "blocking",
                      agent: {
                        backend: "claude" as const,
                        modelSelection: {
                          modelId: "sonnet",
                          parameters: { effort: "medium" },
                        },
                      },
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
        "definition.executionContexts.0 (context-plan).contextValidator.assignments.0 (repo).profile",
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
      getSession: async () => ({
        sessionName: "sess",
        branchName: "csm/sess",
        worktreePath: "/session-worktree",
      }),
      readRepoConfig: async () => null,
      readConfig: async () =>
        makeGlobalConfig({
          validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
        }),
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
