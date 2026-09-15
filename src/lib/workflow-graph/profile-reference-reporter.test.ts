/**
 * R15.1 — the read-only deletion preview, end to end over REAL storage.
 *
 * Every holder here is a file the reporter has to go find: workflow definitions
 * and templates under a temp `<configDir>/workflows/`, and `workflowDefaults`
 * in a temp `config.json`. A JS-object fake could not tell "scanned the global
 * scope" from "scanned this project and guessed", which is exactly the
 * cross-project claim R15.1 makes.
 *
 * The enumeration is ADVISORY by decision D14: nothing here re-checks it at
 * acceptance. The two scenarios that matter — a reference created after the
 * preview, and the artifacts left behind after the delete — are proven against
 * the fail-closed surfaces (`validate`, execution start) rather than against a
 * promise the delete flow does not make.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import type {
  AgentProfileDeletionReport,
  AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import { createConfigReader } from "@/lib/config/loader";
import type { SessionState } from "@/lib/sessions/schemas";

import {
  createAssignmentReferenceChecker,
  WorkflowAssignmentReferenceError,
} from "./assignment-references";
import type { AgentAssignment, ValidatorCohort } from "./config-schemas";
import type { WorkflowSemanticDefinition } from "./definition-schemas";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createWorkflowCharterService } from "./charter/service";
import { createWorkflowProfileReferenceReporter } from "./profile-reference-reporter";
import { createWorkflowStorageService, type WorkflowScope } from "./storage";
import {
  createInMemoryLeaseReservation,
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  makeLaunchDocument,
  makeValidatorAssignment,
} from "./test-fixtures";

const PROJECT_A = "/repos/alpha";
const PROJECT_B = "/repos/beta";
const SCOPE_A: WorkflowScope = { kind: "project", projectPath: PROJECT_A };
const SCOPE_B: WorkflowScope = { kind: "project", projectPath: PROJECT_B };
const GLOBAL_SCOPE: WorkflowScope = { kind: "global" };

const TARGET: AgentProfileRef = { tier: "global", id: "house-reviewer" };

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-profile-reference-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function profileStorage() {
  return createAgentProfileStorage({ resolveConfigDir: () => configDir });
}

function configReader() {
  return createConfigReader(configDir);
}

function reporter() {
  return createWorkflowProfileReferenceReporter({
    storage: workflowStorage(),
    readWorkflowDefaults: async () =>
      (await configReader().readConfig()).workflowDefaults,
  });
}

function libraryService() {
  return createAgentProfileLibraryService({
    storage: profileStorage(),
    referenceReporter: reporter(),
  });
}

function workflowStorage() {
  return createWorkflowStorageService({
    resolveConfigDir: () => configDir,
    assignmentReferences: createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({ storage: profileStorage() }),
    }),
    listActiveExecutions: async () => new Map(),
  });
}

async function seedTargetProfile(): Promise<void> {
  await createAgentProfileLibraryService({ storage: profileStorage() }).create({
    projectPath: PROJECT_A,
    tier: "global",
    id: TARGET.id,
    name: "House Reviewer",
    description: "The house review lens",
    instructions: "Review against the house conventions.",
  });
}

function validatorFor(
  ref: AgentProfileRef,
  overrides: Partial<ValidatorCohort> = {},
): ValidatorCohort {
  return {
    enabled: true,
    assignments: [makeValidatorAssignment({ id: "house", profile: ref })],
    ...overrides,
  };
}

function implementerFor(ref: AgentProfileRef): AgentAssignment {
  return {
    id: "implementer",
    profile: ref,
    agent: {
      backend: "claude",
      modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    },
  };
}

/**
 * A definition whose FIRST context carries the reference, so a holder's
 * `contextId` assertion is about the context tier rather than the workflow one.
 */
function definitionReferencingInContext(
  cohort: ValidatorCohort,
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  const [first, ...rest] = base.executionContexts;
  if (first === undefined) throw new Error("fixture has no execution contexts");
  return {
    ...base,
    executionContexts: [{ ...first, contextValidator: cohort }, ...rest],
  };
}

function definitionReferencingAtWorkflowTier(
  ref: AgentProfileRef,
): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  return {
    ...base,
    workflowConfig: {
      ...base.workflowConfig,
      implementer: implementerFor(ref),
    },
  };
}

async function saveDefinition(
  scope: WorkflowScope,
  name: string,
  definition: WorkflowSemanticDefinition,
): Promise<string> {
  const record = await workflowStorage().create(scope, {
    name,
    description: null,
    definition,
    layout: createWorkflowDefinitionRecord().layout,
  });
  return record.id;
}

async function writeWorkflowDefaultsReferencing(
  ref: AgentProfileRef,
): Promise<void> {
  await configReader().writeRawConfig({
    workflowDefaults: {
      contextValidator: validatorFor(ref),
    },
  });
}

function preview(
  projectPath: string,
  ref: AgentProfileRef,
): Promise<AgentProfileDeletionReport> {
  return libraryService().previewDeletion(projectPath, ref);
}

// ============================================================
// R15.1 — every holder kind, listed before confirmation
// ============================================================

describe("agent profile deletion preview (R15.1)", () => {
  it("lists a saved definition, a template, and workflowDefaults before confirmation, deleting nothing", async () => {
    await seedTargetProfile();
    const definitionId = await saveDefinition(
      SCOPE_A,
      "Alpha Delivery",
      definitionReferencingInContext(validatorFor(TARGET)),
    );
    const templateId = await saveDefinition(
      GLOBAL_SCOPE,
      "Shared Template",
      definitionReferencingAtWorkflowTier(TARGET),
    );
    await writeWorkflowDefaultsReferencing(TARGET);

    const report = await preview(PROJECT_A, TARGET);

    expect(report.savedReferenceEnumeration.definitions).toEqual([
      {
        scope: { kind: "project", projectPath: PROJECT_A },
        id: definitionId,
        name: "Alpha Delivery",
        contextId: "context-plan",
        dormant: false,
      },
    ]);
    expect(report.savedReferenceEnumeration.templates).toEqual([
      {
        scope: { kind: "global" },
        id: templateId,
        name: "Shared Template",
        dormant: false,
      },
    ]);
    expect(report.savedReferenceEnumeration.workflowDefaults).toBe(true);

    // Read-only: the preview is a sibling of delete, not a rehearsal of it.
    expect(report.deletedRevision).toBe(1);
    await expect(
      libraryService().resolve(PROJECT_A, TARGET),
    ).resolves.toMatchObject({ id: TARGET.id, revision: 1 });
    expect(await workflowStorage().get(SCOPE_A, definitionId)).not.toBeNull();
    expect(
      await workflowStorage().get(GLOBAL_SCOPE, templateId),
    ).not.toBeNull();
  });

  it("enumerates a reference held only by a dormant assignment inside a disabled cohort", async () => {
    await seedTargetProfile();
    const definitionId = await saveDefinition(
      SCOPE_A,
      "Validation Off",
      definitionReferencingInContext(validatorFor(TARGET, { enabled: false })),
    );

    const report = await preview(PROJECT_A, TARGET);

    expect(report.savedReferenceEnumeration.definitions).toEqual([
      {
        scope: { kind: "project", projectPath: PROJECT_A },
        id: definitionId,
        name: "Validation Off",
        contextId: "context-plan",
        dormant: true,
      },
    ]);
  });

  it("enumerates a global-tier profile's holders across every project, not just the one previewing", async () => {
    await seedTargetProfile();
    const alphaId = await saveDefinition(
      SCOPE_A,
      "Alpha Delivery",
      definitionReferencingInContext(validatorFor(TARGET)),
    );
    const betaId = await saveDefinition(
      SCOPE_B,
      "Beta Delivery",
      definitionReferencingInContext(validatorFor(TARGET)),
    );

    const report = await preview(PROJECT_A, TARGET);

    expect(
      report.savedReferenceEnumeration.definitions.map((holder) => ({
        projectPath:
          holder.scope.kind === "project" ? holder.scope.projectPath : null,
        id: holder.id,
      })),
    ).toEqual([
      { projectPath: PROJECT_A, id: alphaId },
      { projectPath: PROJECT_B, id: betaId },
    ]);
  });

  it("reports no holders for an unreferenced profile and deletes it cleanly", async () => {
    await seedTargetProfile();
    await saveDefinition(SCOPE_A, "Unrelated", createWorkflowDefinition());

    const report = await preview(PROJECT_A, TARGET);
    expect(report.savedReferenceEnumeration).toEqual({
      definitions: [],
      templates: [],
      workflowDefaults: false,
    });

    const deleted = await libraryService().delete({
      projectPath: PROJECT_A,
      ref: TARGET,
      expectedRevision: 1,
      confirmed: true,
    });
    expect(deleted.savedReferenceEnumeration).toEqual({
      definitions: [],
      templates: [],
      workflowDefaults: false,
    });
  });
});

// ============================================================
// R15.1 — advisory enumeration, fail-closed aftermath
// ============================================================

/**
 * The launch surface, wired to the same temp config dir. In-memory session
 * store and a capturing charter service so the subject stays the pre-seed
 * reference re-check rather than the filesystem around it.
 */
function launchRepository() {
  const sessions = new Map<string, SessionState>();
  return createGraphWorkflowExecutionRepository({
    getGraphWorkflowPendingArtifacts: async () => null,
    clearGraphWorkflowPendingArtifacts: async () => false,

    // No git worktree in this harness; the real exclusion would shell out.
    ensureCcArtifactsExcluded: async () => {},
    async getSession(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (session === undefined) {
        session = {
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          graphWorkflowExecution: null,
        } as unknown as SessionState;
        sessions.set(key, session);
      }
      return session;
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      return (
        sessions.get(`${projectPath}:${sessionName}`)?.graphWorkflowExecution ??
        null
      );
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      _label,
      mutate,
    ) {
      const key = `${projectPath}:${sessionName}`;
      const current = sessions.get(key);
      if (current === undefined) throw new Error(`No session ${key}`);
      const decision = mutate(current.graphWorkflowExecution);
      if (decision.kind === "no_commit")
        return {
          kind: "not_committed" as const,
          execution: current.graphWorkflowExecution,
          value: decision.value,
        };
      const { execution, events, pushes } = decision;
      current.graphWorkflowExecution = execution;
      return {
        kind: "committed" as const,
        value: decision.value,
        execution,
        delivery: { events, pushes: pushes ?? [] },
      };
    },
    reserveActiveGraphWorkflowExecution: createInMemoryLeaseReservation({
      readActive: (projectPath, sessionName) =>
        sessions.get(`${projectPath}:${sessionName}`)?.graphWorkflowExecution ??
        null,
      installActive: (projectPath, sessionName, execution) => {
        const key = `${projectPath}:${sessionName}`;
        const current = sessions.get(key);
        if (current === undefined) throw new Error(`No session ${key}`);
        current.graphWorkflowExecution = execution;
      },
    }),
    async archiveActiveGraphWorkflowExecution() {
      return { archived: false as const, reason: "no_active" as const };
    },

    charterService: createWorkflowCharterService({
      writeFile: async () => {},
      ensureDir: async () => {},
      publishCharterRegistered: () => ({ events: [], pushes: [] }),
    }),
    // The REAL temp config, not an empty stand-in: `workflowDefaults` is one of
    // the holder kinds R15 enumerates, so a launch that never reads it could
    // not fail closed on a dangling default.
    readConfig: async () => configReader().readConfig(),
    agentProfileLibrary: createAgentProfileLibraryService({
      storage: profileStorage(),
    }),
    assignmentReferences: createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({ storage: profileStorage() }),
    }),
  });
}

function launch(definition: WorkflowSemanticDefinition, executionId: string) {
  return launchRepository().create(PROJECT_A, "session-1", {
    definition,
    source: {
      kind: "template",
      definitionId: "wf-1",
      definitionRevision: 1,
      tier: "project",
    },
    launchDocument: makeLaunchDocument(definition),
    executionId,
    startedAt: "2026-08-04T00:00:00.000Z",
    inputs: {},
    ownerConversationId: null,
  });
}

describe("agent profile deletion aftermath (R15.1)", () => {
  it("does not re-check the enumeration at deletion: a reference created after the preview is caught by fail-closed validation instead", async () => {
    await seedTargetProfile();

    const before = await preview(PROJECT_A, TARGET);
    expect(before.savedReferenceEnumeration.definitions).toEqual([]);

    // Authored AFTER the preview and BEFORE the delete. The delete flow makes
    // no recheck promise, so it proceeds.
    const lateDefinition = definitionReferencingInContext(validatorFor(TARGET));
    const lateId = await saveDefinition(
      SCOPE_A,
      "Late Arrival",
      lateDefinition,
    );

    await expect(
      libraryService().delete({
        projectPath: PROJECT_A,
        ref: TARGET,
        expectedRevision: 1,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ deletedRevision: 1 });

    // The late artifact is visibly unlaunchable, located at its own use site.
    const saved = await workflowStorage().get(SCOPE_A, lateId);
    expect(saved).not.toBeNull();
    const issues = await createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({ storage: profileStorage() }),
    }).checkDefinition(lateDefinition, SCOPE_A);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe(
      "definition.executionContexts.0.contextValidator.assignments.0.profile",
    );
    expect(issues[0]?.message).toContain("global:house-reviewer");

    await expect(launch(lateDefinition, "exec-late")).rejects.toThrow(
      /global:house-reviewer/,
    );
  });

  it("leaves an already-seeded execution running while every affected artifact fails validate and launch", async () => {
    await seedTargetProfile();
    const definition = definitionReferencingInContext(validatorFor(TARGET));
    await saveDefinition(SCOPE_A, "Alpha Delivery", definition);

    // Seeded BEFORE the deletion: assignments carry snapshots from here on.
    const execution = await launch(definition, "exec-seeded");
    const seededCohort =
      execution.workingDefinition.executionContexts[0]?.contextValidator;
    const seededSnapshot = seededCohort?.assignments[0]?.profileSnapshot;
    expect(seededSnapshot?.renderedInstructionBlock).toContain(
      "Review against the house conventions.",
    );

    await libraryService().delete({
      projectPath: PROJECT_A,
      ref: TARGET,
      expectedRevision: 1,
      confirmed: true,
    });

    // The running execution never consults the library again.
    expect(
      execution.workingDefinition.executionContexts[0]?.contextValidator
        ?.assignments[0]?.profileSnapshot,
    ).toEqual(seededSnapshot);

    // The saved artifact is unlaunchable, and says exactly why.
    await expect(launch(definition, "exec-after")).rejects.toThrow(
      /global:house-reviewer/,
    );
  });

  /**
   * `workflowDefaults` is one of the three holder kinds the preview enumerates,
   * so it owes the same located failure as the other two. It is the one that
   * can slip: the reference is not authored in the definition at all — it
   * arrives through the cascade — so a launch that checks only definition-
   * authored references sails past it and dies inside snapshot seeding with an
   * unlocated "could not be resolved", naming no field to fix.
   */
  it("fails launch with the located workflowDefaults path when only the global defaults referenced the deleted profile", async () => {
    await seedTargetProfile();
    await writeWorkflowDefaultsReferencing(TARGET);

    // Authored WITHOUT any validator of its own: every reference to the target
    // reaches this definition through the global-defaults cascade.
    const definition = createWorkflowDefinition();
    expect(
      definition.executionContexts.some(
        (context) => context.contextValidator !== undefined,
      ),
    ).toBe(false);

    const report = await preview(PROJECT_A, TARGET);
    expect(report.savedReferenceEnumeration.workflowDefaults).toBe(true);
    expect(report.savedReferenceEnumeration.definitions).toEqual([]);

    await libraryService().delete({
      projectPath: PROJECT_A,
      ref: TARGET,
      expectedRevision: 1,
      confirmed: true,
    });

    const failure = await launch(definition, "exec-defaults").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkflowAssignmentReferenceError);
    if (!(failure instanceof WorkflowAssignmentReferenceError)) return;
    expect(failure.issues).toHaveLength(1);
    expect(failure.issues[0]?.path).toBe(
      "workflowDefaults.contextValidator.assignments.0.profile",
    );
    expect(failure.issues[0]?.message).toContain("global:house-reviewer");
    expect(failure.issues[0]?.message).toContain("global-defaults");
  });
});
