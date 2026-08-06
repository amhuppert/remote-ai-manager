import { describe, expect, it } from "vitest";

import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowCascadeContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { renderCharterDigest } from "@/lib/workflow-graph/charter/render";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import {
  buildFollowUpPrompt,
  buildIterationPrompt,
} from "@/lib/workflow-graph/iteration-prompt";
import { buildContextValidationPrompt } from "@/lib/workflow-graph/validator-runner";
import type { ValidationPromptSelections } from "@/lib/workflow-graph/validation-prompt-section";

/**
 * Cross-builder integration test for charter prompt injection (task 5.2).
 *
 * Unlike the per-builder unit tests in iteration-prompt / validator-runner,
 * this exercises the REAL passthrough chain end-to-end: one charter-bearing
 * WorkflowSemanticDefinition is resolved through `resolveWorkflowDefinition`
 * (task 4.1), and the SAME resolved context's `charter` snapshot is fed to
 * BOTH prompt builders. The load-bearing guarantee here — invisible to the
 * per-builder unit tests — is that the implementer and validator of one
 * context embed byte-identical charter content (4.5).
 *
 * Pure, deterministic, no LLM, no mocks: the production builders are pure
 * functions and the resolver is pure config plumbing.
 */

const GLOBAL_DEFAULTS: WorkflowDefaults = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  },
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    ],
  },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
  agentValidation: {
    implementer: { mode: "all", except: [] },
    contextValidator: { mode: "only", commands: [] },
  },
  laneMergeValidation: {
    strategy: "final-only",
    commands: { mode: "project" },
  },
};

const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

const GLOBAL_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      timeoutMs: null,
    },
  },
  defaultAgentBackend: "claude",
  workflowDefaults: GLOBAL_DEFAULTS,
};

const VALIDATOR: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin", id: "general-reviewer" },
  strategy: "conversation",
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  continuity: { enabled: true },
};

const TASKS: GraphWorkflowTaskDefinition[] = [
  {
    id: "task-1",
    contextId: "ctx-1",
    order: 1,
    title: "Implement the thing",
    instructions: "Do the work and call complete_task.",
    source: "user",
  },
];

function makeTaskState(
  overrides: Partial<GraphWorkflowTaskState> = {},
): GraphWorkflowTaskState {
  return {
    taskId: "task-1",
    contextId: "ctx-1",
    order: 1,
    status: "completed",
    summary: "Did the work.",
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

const TASK_STATES: Record<string, GraphWorkflowTaskState> = {
  "task-1": makeTaskState(),
};

const CHARTER_DOC_ENTRY: GraphWorkflowSharedDocumentEntry = {
  id: "charter-doc",
  relativePath: ".cc/graph-workflow-docs/charter.md",
  description: "The workflow charter",
  readWhen: "On demand for the full charter",
  kind: "charter",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  lastUpdatedByConversationId: null,
};

const GENERIC_DOC_ENTRY: GraphWorkflowSharedDocumentEntry = {
  id: "api-notes",
  relativePath: "docs/api-notes.md",
  description: "Notes on the API surface",
  readWhen: "Before touching the API layer",
  kind: "shared",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  lastUpdatedByConversationId: null,
};

function makeDefinition(): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter({
      mission: "Resolve every source conflict identically across all agents",
    }),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Build the feature",
        description: "Implement the core behavior",
        acceptanceCriteria: "The feature works and is covered by tests.",
      },
    ],
    tasks: TASKS,
    edges: [],
  };
}

/**
 * Resolve a real charter-bearing definition and return the single resolved
 * context — it carries `context.charter` via the task 4.1 passthrough, the
 * same snapshot both roles consume.
 */
function resolveSharedContext(): GraphWorkflowCascadeContext {
  const resolved = resolveWorkflowDefinition(GLOBAL_CONFIG, makeDefinition());
  const context = resolved.executionContexts[0];
  if (!context) {
    throw new Error("expected one resolved execution context");
  }
  return context;
}

// The role-specific instruction block that `renderCharterPromptSection`
// appends after the digest opens with this fixed pointer line. The digest is
// the shared charter content; everything from this line on is role-specific
// (the implementer adds a citation requirement + external-source note, the
// validator adds nothing), so the charter region to compare for 4.5 is the
// slice that precedes this pointer.
const CHARTER_POINTER_LINE = "Full charter: read";

/**
 * Extract the rendered charter digest from a prompt: the `# Workflow Charter`
 * region up to (but excluding) the role-specific pointer/instruction block.
 * This is the genuine "charter content" boundary for 4.5 — role-specific
 * guidance that legitimately differs between implementer and validator is
 * deliberately excluded.
 */
function extractCharterDigestRegion(prompt: string): string {
  const start = prompt.indexOf("# Workflow Charter");
  expect(start).toBeGreaterThanOrEqual(0);
  const region = prompt.slice(start);
  const pointerAt = region.indexOf(CHARTER_POINTER_LINE);
  expect(pointerAt).toBeGreaterThanOrEqual(0);
  return region.slice(0, pointerAt).trimEnd();
}

describe("charter prompt injection (cross-builder integration)", () => {
  it("places the charter digest at the top of the implementer prompt and omits the charter from the generic document list (4.1, 4.3, 4.2)", () => {
    const context = resolveSharedContext();
    expect(context.charter).toBeDefined();

    const prompt = buildIterationPrompt({
      context,
      charter: context.charter,
      sharedDocuments: [CHARTER_DOC_ENTRY, GENERIC_DOC_ENTRY],
      tasks: TASKS,
      taskStates: TASK_STATES,
      allowAgentTaskAdd: false,
      contextValidationAcceptanceCriteria: context.acceptanceCriteria,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    // Digest opens the prompt (4.1, 4.3).
    expect(prompt.startsWith("# Workflow Charter")).toBe(true);

    // The generic "## Shared Documents" list carries the kind:"shared" doc but
    // NOT the kind:"charter" entry — the charter has its own top section (4.2).
    const sharedDocsIndex = prompt.indexOf("## Shared Documents");
    expect(sharedDocsIndex).toBeGreaterThanOrEqual(0);
    const sharedDocsSection = prompt.slice(sharedDocsIndex);
    expect(sharedDocsSection).toContain(GENERIC_DOC_ENTRY.relativePath);
    expect(sharedDocsSection).not.toContain(CHARTER_DOC_ENTRY.relativePath);
  });

  it("places the charter digest at the top of the validator prompt (4.2)", () => {
    const context = resolveSharedContext();

    const prompt = buildContextValidationPrompt({
      context,
      charter: context.charter,
      tasks: TASKS,
      taskStates: TASK_STATES,
      validator: VALIDATOR,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    expect(prompt.startsWith("# Workflow Charter")).toBe(true);
  });

  it("carries a compact charter reference on the follow-up prompt (4.4)", () => {
    const context = resolveSharedContext();

    const prompt = buildFollowUpPrompt({
      charter: context.charter,
      remainingTasks: TASKS,
      taskStates: { "task-1": makeTaskState({ status: "running" }) },
      attemptNumber: 2,
      maxAttempts: 5,
    });

    // The follow-up carries a pointer to the full charter and the precedence
    // reminder, not the full digest (it is re-seeded via buildIterationPrompt
    // on a fresh session).
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
    expect(prompt).toContain("charter");
    expect(prompt.startsWith("# Workflow Charter")).toBe(false);
  });

  it("embeds byte-identical charter content in the implementer and validator prompts of the same context (4.5)", () => {
    const context = resolveSharedContext();
    if (!context.charter) {
      throw new Error("resolved context must carry a charter");
    }

    const implementerPrompt = buildIterationPrompt({
      context,
      charter: context.charter,
      sharedDocuments: [CHARTER_DOC_ENTRY, GENERIC_DOC_ENTRY],
      tasks: TASKS,
      taskStates: TASK_STATES,
      allowAgentTaskAdd: false,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });
    const validatorPrompt = buildContextValidationPrompt({
      context,
      charter: context.charter,
      tasks: TASKS,
      taskStates: TASK_STATES,
      validator: VALIDATOR,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    // The shared digest both roles embed, computed from the SAME snapshot.
    const digest = renderCharterDigest(context.charter);
    expect(digest).toContain("# Workflow Charter");
    expect(digest).toContain("Resolve every source conflict identically");
    expect(implementerPrompt).toContain(digest);
    expect(validatorPrompt).toContain(digest);

    // The extracted digest region is byte-identical across roles — same
    // context.charter → identical charter content (4.5). Role-specific guidance
    // that legitimately differs (implementer citation requirement, external-
    // source note) lives after the pointer line and is excluded.
    const implementerDigestRegion =
      extractCharterDigestRegion(implementerPrompt);
    const validatorDigestRegion = extractCharterDigestRegion(validatorPrompt);
    expect(implementerDigestRegion).toBe(validatorDigestRegion);
    // Guard: the compared region is the real digest, not an empty/stub slice.
    expect(implementerDigestRegion).toBe(digest);
  });
});
