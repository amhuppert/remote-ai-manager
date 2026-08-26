import { describe, expect, it, vi } from "vitest";
import type {
  AgentBackendsConfig,
  GlobalConfig,
  PerRepoConfig,
  WorkflowDefaults,
} from "@/lib/config/schemas";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { BackendModelCatalogFacet } from "@/lib/agent-backends/descriptor";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { unreviewedPlanReviewLookup } from "@/lib/shared/testing/graph-plan-review-fixture";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import type { WorkflowDefinitionDraft } from "@/lib/workflow-graph/storage";
import {
  createWorkflowDefinitionRecord,
  makeImplementerAssignment,
  TEST_AGENT_BACKENDS_CONFIG,
} from "@/lib/workflow-graph/test-fixtures";
import type {
  AssignmentDocumentScope,
  AssignmentReferenceChecker,
} from "./assignment-references";
import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";
import { createGraphWorkflowValidateHandlers } from "./validate-route-handlers";
import { createTemplateLibraryRouteHandlers } from "./template-library-route-handlers";
import { createWorkflowDefinitionRouteHandlers } from "@/lib/workflows/definition-route-handlers";
import {
  MAXIMAL_AUTHORED_LAUNCH_ACCOUNTABILITY_GROUPS,
  createMaximalAuthoredWorkflowLaunchFixture,
} from "./testing/maximal-authored-launch";

const admissionLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => admissionLogger,
  withTracing: <T>(handler: T): T => handler,
}));

const maximalLaunch = createMaximalAuthoredWorkflowLaunchFixture;

const agentBackends = TEST_AGENT_BACKENDS_CONFIG;

function references(
  expectedScope: AssignmentDocumentScope,
  defaultsIssues: ReadonlyArray<{ path: string; message: string }> = [],
): AssignmentReferenceChecker {
  return {
    async checkDefinition(definition, scope) {
      const profile = definition.workflowConfig.implementer?.profile;
      if (
        profile?.id === "missing" ||
        (scope.kind === "global" && profile?.tier === "project")
      ) {
        return [
          {
            path: "definition.workflowConfig.implementer.profile",
            message:
              "Definition profile is unavailable in this document scope.",
          },
        ];
      }
      if (scope.kind === expectedScope.kind) return [];
      return [
        {
          path: "definition",
          message: "Document scope did not reach profile resolution.",
        },
      ];
    },
    async checkWorkflowDefaults() {
      return [...defaultsIssues];
    },
  };
}

describe("admitAuthoredWorkflowLaunch", () => {
  it("refuses an arbitrary Codex selection that is not the globally configured custom model", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    const launch = maximalLaunch();
    launch.definition.workflowConfig.implementer = makeImplementerAssignment({
      backend: "codex",
      modelSelection: {
        modelId: "arbitrary-codex-model",
        parameters: { fast: "false", reasoning: "high" },
      },
    });

    const result = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-create",
      documentScope: scope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: undefined,
      agentBackends,
      assignmentReferences: references(scope),
    });

    expect(result).toEqual({
      ok: false,
      code: "workflow_model_selection_invalid",
      issues: [
        expect.objectContaining({
          path: "definition.workflowConfig.implementer.agent.modelSelection.modelId",
          code: "unknown_model",
          modelId: "arbitrary-codex-model",
          message: expect.stringContaining("arbitrary-codex-model"),
        }),
      ],
    });
  });

  it("accepts the one globally configured custom Codex model", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    const customSelection = {
      modelId: "company-codex",
      parameters: { fast: "false", reasoning: "high" },
    };
    const configuredBackends: AgentBackendsConfig = {
      ...agentBackends,
      codex: {
        ...agentBackends.codex,
        modelSelection: customSelection,
      },
    };
    const launch = maximalLaunch();
    launch.definition.workflowConfig.planRepair = {
      enabled: true,
      maxAttemptsPerContext: 2,
      agent: { backend: "codex", modelSelection: customSelection },
    };

    await expect(
      admitAuthoredWorkflowLaunch(launch, {
        caller: "project-create",
        documentScope: scope,
        projectValidation: repoValidation,
        globalValidation: globalConfig.validation,
        workflowDefaults: undefined,
        agentBackends: configuredBackends,
        assignmentReferences: references(scope),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("canonicalizes aliases across every authored role and passes project scope to the catalog facet", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    const launch = maximalLaunch();
    const aliasSelection = {
      modelId: "claude-opus-alias",
      parameters: { effort: "high" },
    };
    const assignment = () =>
      makeImplementerAssignment({
        backend: "claude",
        modelSelection: structuredClone(aliasSelection),
      });
    launch.definition.workflowConfig.implementer = assignment();
    launch.definition.workflowConfig.contextValidator = {
      enabled: false,
      assignments: [
        {
          ...launch.definition.workflowConfig.contextValidator!.assignments[0]!,
          agent: {
            backend: "claude",
            modelSelection: structuredClone(aliasSelection),
          },
        },
      ],
    };
    launch.definition.workflowConfig.planRepair!.agent = {
      backend: "claude",
      modelSelection: structuredClone(aliasSelection),
    };
    launch.definition.workflowConfig.collaboration!.secondAgent = {
      backend: "claude",
      modelSelection: structuredClone(aliasSelection),
    };
    const loopContext = launch.definition.executionContexts[1]!;
    loopContext.implementer = assignment();
    loopContext.contextValidator = {
      enabled: false,
      assignments: [
        {
          ...launch.definition.workflowConfig.contextValidator!.assignments[0]!,
          agent: {
            backend: "claude",
            modelSelection: structuredClone(aliasSelection),
          },
        },
      ],
    };
    loopContext.planRepair = {
      enabled: false,
      maxAttemptsPerContext: 1,
      agent: {
        backend: "claude",
        modelSelection: structuredClone(aliasSelection),
      },
    };
    loopContext.collaboration = {
      enabled: false,
      secondAgent: {
        backend: "claude",
        modelSelection: structuredClone(aliasSelection),
      },
    };
    const getCatalog = vi.fn<BackendModelCatalogFacet["getCatalog"]>(
      async ({ configuredSelection }) => {
        const catalog = getConfiguredBackendModelCatalog(
          "claude",
          configuredSelection,
        );
        return {
          ...catalog,
          models: catalog.models.map((model) =>
            model.id === "opus"
              ? {
                  ...model,
                  aliases: [...model.aliases, aliasSelection.modelId],
                }
              : model,
          ),
        };
      },
    );
    const modelCatalogFor: (
      backend: AgentBackendId,
    ) => BackendModelCatalogFacet = (backend) =>
      backend === "claude"
        ? { getCatalog }
        : {
            getCatalog: async ({ configuredSelection }) =>
              getConfiguredBackendModelCatalog(backend, configuredSelection),
          };

    const result = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-create",
      documentScope: scope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: undefined,
      agentBackends,
      modelCatalogFor,
      assignmentReferences: references(scope),
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(getCatalog).toHaveBeenCalledWith({
      projectPath: scope.projectPath,
      configuredSelection: agentBackends.claude.modelSelection,
    });
    expect(
      result.launch.definition.workflowConfig.implementer?.agent.modelSelection
        .modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.workflowConfig.contextValidator?.assignments[0]
        ?.agent.modelSelection.modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.workflowConfig.planRepair?.agent?.modelSelection
        .modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.workflowConfig.collaboration?.secondAgent
        ?.modelSelection.modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.executionContexts[1]?.implementer?.agent
        .modelSelection.modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.executionContexts[1]?.planRepair?.agent
        ?.modelSelection.modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.executionContexts[1]?.contextValidator
        ?.assignments[0]?.agent.modelSelection.modelId,
    ).toBe("opus");
    expect(
      result.launch.definition.executionContexts[1]?.collaboration?.secondAgent
        ?.modelSelection.modelId,
    ).toBe("opus");
    expect(
      launch.definition.workflowConfig.implementer?.agent.modelSelection,
    ).toEqual(aliasSelection);
  });

  it("normalizes the maximal full-dialect launch and preserves its warning", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    const launch = maximalLaunch();
    const original = structuredClone(launch);

    const result = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-validate",
      documentScope: scope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: undefined,
      agentBackends,
      assignmentReferences: references(scope),
      accountabilityGroups: MAXIMAL_AUTHORED_LAUNCH_ACCOUNTABILITY_GROUPS,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Admission canonicalizes prose acceptance criteria to records (#69
    // change 4 stage 1) and changes nothing else about the launch.
    expect(result.launch).toEqual({
      ...launch,
      definition: {
        ...launch.definition,
        executionContexts: launch.definition.executionContexts.map(
          (context) => ({
            ...context,
            acceptanceCriteria: criterionRecordsOf(context.acceptanceCriteria),
          }),
        ),
      },
    });
    expect(launch).toEqual(original);
    expect(Object.keys(result).sort()).toEqual([
      "accountabilityGroupAnalysis",
      "launch",
      "ok",
      "stableAccountabilityContextIds",
      "warnings",
    ]);
    expect(result.stableAccountabilityContextIds).toEqual([
      "context-spawner",
      "context-alternate",
      "context-audit",
      "context-fallback",
      "context-integrate",
    ]);
    expect(result.accountabilityGroupAnalysis).toEqual([
      expect.objectContaining({
        bindingKey: "stable-spawner",
        covered: true,
      }),
      expect.objectContaining({
        bindingKey: "post-loop-integration",
        covered: true,
      }),
      expect.objectContaining({
        bindingKey: "loop-template-is-not-claimable",
        covered: false,
      }),
    ]);
    // Containment, not equality: the semantic authoring lints (#69 change 6)
    // also report against this fixture's charter, and the subject here is the
    // guard warning surviving admission — not the whole warning set.
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        path: "definition.executionContexts[0].outputSchema.properties.verdict.enum",
        message: expect.stringContaining("defer"),
      }),
    );
  });

  it("observes profile and default-reference changes on each request", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    let defaultsAreInvalid = false;
    const assignmentReferences: AssignmentReferenceChecker = {
      async checkDefinition() {
        return [];
      },
      async checkWorkflowDefaults() {
        return defaultsAreInvalid
          ? [
              {
                path: "workflowDefaults.implementer.profile",
                message: "The default profile was deleted.",
              },
            ]
          : [];
      },
    };
    const deps = {
      caller: "project-validate" as const,
      documentScope: scope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: {} as Partial<WorkflowDefaults>,
      agentBackends,
      assignmentReferences,
    };

    await expect(
      admitAuthoredWorkflowLaunch(maximalLaunch(), deps),
    ).resolves.toMatchObject({
      ok: true,
    });
    defaultsAreInvalid = true;
    await expect(
      admitAuthoredWorkflowLaunch(maximalLaunch(), deps),
    ).resolves.toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "workflowDefaults.implementer.profile",
        }),
      ],
    });
  });

  it("logs graph warnings when profile resolution rejects an otherwise valid launch", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    const launch = maximalLaunch();
    launch.definition.workflowConfig.implementer = makeImplementerAssignment(
      {
        backend: "claude",
        modelSelection: { modelId: "opus", parameters: { effort: "high" } },
      },
      { profile: { tier: "project", id: "missing" } },
    );
    admissionLogger.warn.mockClear();

    await expect(
      admitAuthoredWorkflowLaunch(launch, {
        caller: "project-validate",
        documentScope: scope,
        projectValidation: repoValidation,
        globalValidation: globalConfig.validation,
        workflowDefaults: undefined,
        agentBackends,
        assignmentReferences: references(scope),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "workflow_assignment_reference_invalid",
    });
    expect(admissionLogger.warn).toHaveBeenCalledWith(
      "workflow-graph.authored-launch-admission.rejected",
      expect.objectContaining({ issueCount: 1 }),
    );
    // The count itself, not a fixed number: the plan parse produced warnings
    // (guard coverage plus the semantic authoring lints) and the rejection log
    // has to carry them even though the launch was refused downstream.
    const rejection = admissionLogger.warn.mock.calls.find(
      ([event]) =>
        event === "workflow-graph.authored-launch-admission.rejected",
    )?.[1] as { warningCount: number } | undefined;
    expect(rejection?.warningCount).toBeGreaterThan(0);
  });

  it("refuses an unregistered caller at the admission boundary", async () => {
    const scope = { kind: "project", projectPath: "/repo" } as const;
    await expect(
      admitAuthoredWorkflowLaunch(maximalLaunch(), {
        caller: "unregistered-mutation" as never,
        documentScope: scope,
        projectValidation: repoValidation,
        globalValidation: globalConfig.validation,
        workflowDefaults: undefined,
        agentBackends,
        assignmentReferences: references(scope),
      }),
    ).rejects.toThrow("Unregistered authored-launch admission caller");
  });

  it.each([
    {
      label: "project definition reference failure",
      scope: { kind: "project", projectPath: "/repo" } as const,
      defaultIssues: [],
      mutate: (launch: WorkflowDefinitionDraft) => {
        launch.definition.workflowConfig.implementer =
          makeImplementerAssignment(
            {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "high" },
              },
            },
            { profile: { tier: "project", id: "missing" } },
          );
      },
      expectedPath: "definition.workflowConfig.implementer.profile",
    },
    {
      label: "global template scope failure",
      scope: { kind: "global" } as const,
      defaultIssues: [],
      mutate: (launch: WorkflowDefinitionDraft) => {
        launch.definition.workflowConfig.implementer =
          makeImplementerAssignment(
            {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "high" },
              },
            },
            { profile: { tier: "project", id: "not-global" } },
          );
      },
      expectedPath: "definition.workflowConfig.implementer.profile",
    },
    {
      label: "inherited global default reference failure",
      scope: { kind: "project", projectPath: "/repo" } as const,
      defaultIssues: [
        {
          path: "workflowDefaults.contextValidator.assignments.0.profile",
          message: "Default profile is missing.",
        },
      ],
      mutate: (_launch: WorkflowDefinitionDraft) => undefined,
      expectedPath: "workflowDefaults.contextValidator.assignments.0.profile",
    },
  ])(
    "returns located issues for $label",
    async ({ scope, defaultIssues, mutate, expectedPath }) => {
      const launch = maximalLaunch();
      mutate(launch);

      const result = await admitAuthoredWorkflowLaunch(launch, {
        caller:
          scope.kind === "global"
            ? "global-template-create"
            : "project-validate",
        documentScope: scope,
        ...(scope.kind === "global"
          ? {}
          : { projectValidation: repoValidation }),
        globalValidation: globalConfig.validation,
        workflowDefaults: {} as Partial<WorkflowDefaults>,
        agentBackends,
        assignmentReferences: references(scope, defaultIssues),
      });

      expect(result).toMatchObject({ ok: false });
      if (result.ok) return;
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: expectedPath }),
      );
    },
  );
});

const repoValidation = {
  commands: {
    lint: {
      command: { full: "scripts/validate/lint.sh" },
      cost: 1,
      pathArgs: "forbid",
    },
    format: {
      command: { full: "scripts/validate/format.sh" },
      cost: 1,
      pathArgs: "forbid",
    },
  },
  preMerge: ["lint"],
  laneMerge: ["lint"],
} satisfies NonNullable<PerRepoConfig["validation"]>;

const globalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends,
  defaultAgentBackend: "claude",
  validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
} satisfies GlobalConfig;

function request(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken() {
    return { kind: "valid" };
  },
};

describe("ordinary authored-launch callers", () => {
  it("uses one normalized launch and warnings across validate, project mutations, and global template mutations", async () => {
    const projectScope = { kind: "project", projectPath: "/repo" } as const;
    const globalScope = { kind: "global" } as const;
    const launch = maximalLaunch();
    const expectedProject = await admitAuthoredWorkflowLaunch(launch, {
      caller: "project-validate",
      documentScope: projectScope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: undefined,
      agentBackends,
      assignmentReferences: references(projectScope),
    });
    expect(expectedProject.ok).toBe(true);
    if (!expectedProject.ok) return;
    const expectedGlobal = await admitAuthoredWorkflowLaunch(launch, {
      caller: "global-template-validate",
      documentScope: globalScope,
      projectValidation: repoValidation,
      globalValidation: globalConfig.validation,
      workflowDefaults: undefined,
      agentBackends,
      assignmentReferences: references(globalScope),
    });
    expect(expectedGlobal.ok).toBe(true);
    if (!expectedGlobal.ok) return;
    // Document scope governs profile resolution, not filesystem authority.
    // Synchronous admission therefore returns the same root-independent
    // lexical warnings for project and global documents.
    expect(expectedGlobal.launch).toEqual(expectedProject.launch);
    expect(expectedGlobal.stableAccountabilityContextIds).toEqual(
      expectedProject.stableAccountabilityContextIds,
    );
    expect(expectedProject.warnings).toEqual(expectedGlobal.warnings);

    const created: WorkflowDefinitionDraft[] = [];
    const updated: WorkflowDefinitionDraft[] = [];
    const stored = createWorkflowDefinitionRecord({
      id: "project-workflow",
      revision: 3,
      ...expectedProject.launch,
    });
    const projectHandlers = createWorkflowDefinitionRouteHandlers({
      planReviews: unreviewedPlanReviewLookup,
      resolveProjectPath: async () => "/repo",
      readConfig: async () => globalConfig,
      readRepoConfig: async () => ({ validation: repoValidation }),
      listDefinitions: async () => [],
      getDefinition: async () => stored,
      createDefinition: async (_projectPath, draft) => {
        created.push(draft);
        return { ...stored, ...draft };
      },
      updateDefinition: async (_projectPath, _workflowId, draft) => {
        updated.push(draft);
        return { ...stored, ...draft, revision: stored.revision + 1 };
      },
      deleteDefinition: async () => true,
      assignmentReferences: references(projectScope),
    });
    const validateHandlers = createGraphWorkflowValidateHandlers({
      auth,
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({
        sessionName: "session",
        branchName: "csm/session",
        worktreePath: "/not-a-repository",
      }),
      readRepoConfig: async () => ({ validation: repoValidation }),
      readConfig: async () => globalConfig,
      assignmentReferences: references(projectScope),
    });
    const globalValidateHandlers = createGraphWorkflowValidateHandlers({
      auth,
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({
        sessionName: "session",
        branchName: "csm/session",
        worktreePath: "/not-a-repository",
      }),
      readRepoConfig: async () => ({ validation: repoValidation }),
      readConfig: async () => globalConfig,
      assignmentReferences: references(globalScope),
    });

    const validateResponse = await validateHandlers.POST(
      request(
        "/api/projects/repo/sessions/session/graph-workflow/validate",
        "POST",
        launch,
      ),
      { params: Promise.resolve({ name: "repo", session: "session" }) },
    );
    expect(await validateResponse.json()).toEqual({
      ok: true,
      warnings: expectedProject.warnings,
    });
    const globalValidateResponse = await globalValidateHandlers.POST(
      request(
        "/api/projects/repo/sessions/session/graph-workflow/validate?tier=global",
        "POST",
        launch,
      ),
      { params: Promise.resolve({ name: "repo", session: "session" }) },
    );
    expect(await globalValidateResponse.json()).toEqual({
      ok: true,
      warnings: expectedGlobal.warnings,
    });

    await projectHandlers.CREATE(
      request("/api/projects/repo/workflows", "POST", launch),
      { params: Promise.resolve({ name: "repo" }) },
    );
    await projectHandlers.UPDATE(
      request("/api/projects/repo/workflows/project-workflow", "PUT", launch),
      {
        params: Promise.resolve({
          name: "repo",
          workflowId: "project-workflow",
        }),
      },
    );
    expect(created).toEqual([expectedProject.launch]);
    expect(updated).toEqual([expectedProject.launch]);

    await projectHandlers.EDIT(
      request("/api/projects/repo/workflows/project-workflow", "PATCH", {
        baseRevision: 3,
        operations: [
          { type: "update-workflow", name: "Edited maximal fixture" },
        ],
      }),
      {
        params: Promise.resolve({
          name: "repo",
          workflowId: "project-workflow",
        }),
      },
    );
    expect(updated[1]).toMatchObject({
      ...expectedProject.launch,
      name: "Edited maximal fixture",
    });

    const globalCreated: WorkflowDefinitionDraft[] = [];
    const globalUpdated: WorkflowDefinitionDraft[] = [];
    const globalStored = createWorkflowDefinitionRecord({
      id: "global-template",
      revision: 3,
      ...expectedProject.launch,
    });
    const templateHandlers = createTemplateLibraryRouteHandlers({
      resolveProjectPath: async () => "/repo",
      readConfig: async () => globalConfig,
      list: async () => [],
      listGlobal: async () => [],
      createGlobal: async (draft) => {
        globalCreated.push(draft);
        return { ...globalStored, ...draft };
      },
      getGlobal: async () => globalStored,
      updateGlobal: async (_workflowId, draft) => {
        globalUpdated.push(draft);
        return {
          ...globalStored,
          ...draft,
          revision: globalStored.revision + 1,
        };
      },
      deleteGlobal: async () => true,
      assignmentReferences: references(globalScope),
    });

    await templateHandlers.CREATE(
      request("/api/workflow-templates", "POST", launch),
      { params: Promise.resolve({}) },
    );
    await templateHandlers.UPDATE(
      request("/api/workflow-templates/global-template", "PUT", launch),
      { params: Promise.resolve({ workflowId: "global-template" }) },
    );
    expect(globalCreated).toEqual([expectedGlobal.launch]);
    expect(globalUpdated).toEqual([expectedGlobal.launch]);

    await templateHandlers.EDIT(
      request("/api/workflow-templates/global-template", "PATCH", {
        baseRevision: 3,
        operations: [
          { type: "update-workflow", name: "Edited global fixture" },
        ],
      }),
      { params: Promise.resolve({ workflowId: "global-template" }) },
    );
    expect(globalUpdated[1]).toMatchObject({
      ...expectedProject.launch,
      name: "Edited global fixture",
    });
  });

  it("returns the same located assignment-reference refusal through every ordinary caller", async () => {
    const projectScope = { kind: "project", projectPath: "/repo" } as const;
    const globalScope = { kind: "global" } as const;
    const issue = {
      path: "definition.workflowConfig.implementer.profile",
      message: "Definition profile is unavailable in this document scope.",
    };
    const expectedValidateRefusal = {
      error: "Workflow plan is invalid",
      issues: [issue],
    };
    const expectedPersistenceRefusal = {
      error: "Workflow assignment references are invalid",
      code: "workflow_assignment_reference_invalid",
      issues: [issue],
    };
    const projectLaunch = maximalLaunch();
    projectLaunch.definition.workflowConfig.implementer =
      makeImplementerAssignment(
        {
          backend: "claude",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        },
        { profile: { tier: "project", id: "missing" } },
      );
    const globalLaunch = maximalLaunch();
    globalLaunch.definition.workflowConfig.implementer =
      makeImplementerAssignment(
        {
          backend: "claude",
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        },
        { profile: { tier: "builtin", id: "missing" } },
      );
    const validRecord = createWorkflowDefinitionRecord({
      id: "persisted",
      revision: 3,
      ...maximalLaunch(),
    });
    const projectPersist = {
      create: [] as WorkflowDefinitionDraft[],
      update: [] as WorkflowDefinitionDraft[],
    };
    const projectHandlers = createWorkflowDefinitionRouteHandlers({
      planReviews: unreviewedPlanReviewLookup,
      resolveProjectPath: async () => "/repo",
      readConfig: async () => globalConfig,
      readRepoConfig: async () => ({ validation: repoValidation }),
      listDefinitions: async () => [],
      getDefinition: async () => validRecord,
      createDefinition: async (_projectPath, draft) => {
        projectPersist.create.push(draft);
        return { ...validRecord, ...draft };
      },
      updateDefinition: async (_projectPath, _workflowId, draft) => {
        projectPersist.update.push(draft);
        return { ...validRecord, ...draft };
      },
      deleteDefinition: async () => true,
      assignmentReferences: references(projectScope),
    });
    const validateHandlers = createGraphWorkflowValidateHandlers({
      auth,
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({
        sessionName: "session",
        branchName: "csm/session",
        worktreePath: "/not-a-repository",
      }),
      readRepoConfig: async () => ({ validation: repoValidation }),
      readConfig: async () => globalConfig,
      assignmentReferences: references(projectScope),
    });
    const globalValidateHandlers = createGraphWorkflowValidateHandlers({
      auth,
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({
        sessionName: "session",
        branchName: "csm/session",
        worktreePath: "/not-a-repository",
      }),
      readRepoConfig: async () => ({ validation: repoValidation }),
      readConfig: async () => globalConfig,
      assignmentReferences: references(globalScope),
    });
    const globalPersist = {
      create: [] as WorkflowDefinitionDraft[],
      update: [] as WorkflowDefinitionDraft[],
    };
    const templateHandlers = createTemplateLibraryRouteHandlers({
      resolveProjectPath: async () => "/repo",
      readConfig: async () => globalConfig,
      list: async () => [],
      listGlobal: async () => [],
      createGlobal: async (draft) => {
        globalPersist.create.push(draft);
        return { ...validRecord, ...draft };
      },
      getGlobal: async () => validRecord,
      updateGlobal: async (_workflowId, draft) => {
        globalPersist.update.push(draft);
        return { ...validRecord, ...draft };
      },
      deleteGlobal: async () => true,
      assignmentReferences: references(globalScope),
    });

    const responses = await Promise.all([
      validateHandlers.POST(
        request(
          "/api/projects/repo/sessions/session/graph-workflow/validate",
          "POST",
          projectLaunch,
        ),
        { params: Promise.resolve({ name: "repo", session: "session" }) },
      ),
      globalValidateHandlers.POST(
        request(
          "/api/projects/repo/sessions/session/graph-workflow/validate?tier=global",
          "POST",
          globalLaunch,
        ),
        { params: Promise.resolve({ name: "repo", session: "session" }) },
      ),
      projectHandlers.CREATE(
        request("/api/projects/repo/workflows", "POST", projectLaunch),
        { params: Promise.resolve({ name: "repo" }) },
      ),
      projectHandlers.UPDATE(
        request("/api/projects/repo/workflows/persisted", "PUT", projectLaunch),
        { params: Promise.resolve({ name: "repo", workflowId: "persisted" }) },
      ),
      projectHandlers.EDIT(
        request("/api/projects/repo/workflows/persisted", "PATCH", {
          baseRevision: 3,
          operations: [
            {
              type: "update-workflow-config",
              implementer: makeImplementerAssignment(
                {
                  backend: "claude",
                  modelSelection: {
                    modelId: "opus",
                    parameters: { effort: "high" },
                  },
                },
                { profile: { tier: "project", id: "missing" } },
              ),
            },
          ],
        }),
        { params: Promise.resolve({ name: "repo", workflowId: "persisted" }) },
      ),
      templateHandlers.CREATE(
        request("/api/workflow-templates", "POST", globalLaunch),
        { params: Promise.resolve({}) },
      ),
      templateHandlers.UPDATE(
        request("/api/workflow-templates/persisted", "PUT", globalLaunch),
        { params: Promise.resolve({ workflowId: "persisted" }) },
      ),
      templateHandlers.EDIT(
        request("/api/workflow-templates/persisted", "PATCH", {
          baseRevision: 3,
          operations: [
            {
              type: "update-workflow-config",
              implementer: makeImplementerAssignment(
                {
                  backend: "claude",
                  modelSelection: {
                    modelId: "opus",
                    parameters: { effort: "high" },
                  },
                },
                { profile: { tier: "builtin", id: "missing" } },
              ),
            },
          ],
        }),
        { params: Promise.resolve({ workflowId: "persisted" }) },
      ),
    ]);

    const [
      projectValidateResponse,
      globalValidateResponse,
      ...persistenceResponses
    ] = responses;
    for (const response of [projectValidateResponse, globalValidateResponse]) {
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toEqual(expectedValidateRefusal);
    }
    for (const response of persistenceResponses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual(
        expectedPersistenceRefusal,
      );
    }
    expect(projectPersist).toEqual({ create: [], update: [] });
    expect(globalPersist).toEqual({ create: [], update: [] });
  });
});
