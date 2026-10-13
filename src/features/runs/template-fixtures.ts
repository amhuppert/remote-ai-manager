import { z } from "zod";
import type { ProjectBackendModelOptions } from "@/lib/agent-backends/project-model-options-schema";
import {
  getBackendCatalogEntry,
  getStaticBackendModelCatalog,
} from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import type { AgentProfileLibraryItem } from "@/lib/agent-profiles/schemas";
import type {
  RunTemplateContext,
  RunTemplateRecord,
} from "@/lib/run-templates/document";
import type { RunTemplateSummary } from "@/lib/run-templates/schemas";
import type { ReviewerSetting } from "@/lib/runs/settings";
import type { OwnerChoice } from "./components/template/LaunchDialog";

/**
 * A saved run template as the server stores it, and the options its editor
 * offers. The run snapshots in `fixtures.ts` are launched from this template,
 * so the editor, the diagram and the run page show one authored topology.
 */

/** A guard or loop exit: true when the accepted output's field is true. */
function whenTrue(field: string, title: string): Record<string, unknown> {
  return {
    title,
    type: "object",
    properties: { [field]: { const: true } },
    required: [field],
  };
}

/** A context's output schema from its Zod contract, as the plain JSON a stored template holds. */
function outputSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  // The spread drops the generator's non-JSON `~standard` marker, which a stored document never carries.
  return { ...z.toJSONSchema(z.object(shape)) };
}

const publicChanges = whenTrue("publicChanges", "public API changed");
const copyApproved = whenTrue("approved", "the copy reviewer approves");

const generalReviewer = { tier: "builtin", id: "general-reviewer" } as const;

const correctness: ReviewerSetting = {
  authority: "blocking",
  focus: "Correctness",
  profile: generalReviewer,
  backend: "codex",
  modelSelection: {
    modelId: "gpt-6-sol",
    parameters: { fast: "false", reasoning: "high" },
  },
};

function advisory(focus: string): ReviewerSetting {
  return {
    authority: "advisory",
    focus,
    profile: generalReviewer,
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
  };
}

const contexts: RunTemplateContext[] = [
  {
    key: "plan",
    scope: { mode: "readOnly" },
    title: "Plan the rollout",
    brief:
      "Read the {{inputs.flag}} spec and the current code. Return a rollout plan: the order of work, the API contract, the migration and the flag rollout.",
    tasks: [
      { title: "Read the spec and the current code" },
      { title: "Draft the rollout plan" },
      {
        title: "Return the rollout plan",
        instructions: "Include the complete plan in your closing response.",
      },
    ],
    acceptanceCriteria: [
      "The rollout plan orders the work so the API lands before the UI uses it",
      "The current public API stays unchanged",
    ],
    settings: { reviewers: [{ ...correctness, focus: "Feasibility" }] },
  },
  {
    key: "api",
    scope: { mode: "owned", paths: ["src/api", "src/orders"] },
    dependsOn: [{ key: "plan", outputOnly: true }],
    lane: "api",
    title: "Build the API",
    brief:
      "Add the endpoints described in the accepted rollout plan behind the {{inputs.flag}} flag. Keep the current handlers as they are.",
    tasks: [
      { title: "Add the endpoints" },
      { title: "Contract tests" },
      { title: "Publish api-contract.md" },
    ],
    acceptanceCriteria: [
      "Every endpoint validates input with the shared schemas",
    ],
    outputSchema: outputSchemaOf({
      endpoints: z.array(z.string()),
      publicChanges: z.boolean(),
    }),
    settings: {
      reviewers: [correctness, advisory("API design")],
      checks: ["typecheck", "test"],
    },
  },
  {
    key: "migrate",
    scope: { mode: "owned", paths: ["db"] },
    dependsOn: [{ key: "plan", outputOnly: true }, "api", "ui"],
    title: "Migrate the data",
    brief:
      "Add the new columns with a reversible migration. Backfill in batches; never lock the table.",
    tasks: [
      { title: "Write the migration" },
      { title: "Batch backfill" },
      { title: "Rollback test" },
    ],
    acceptanceCriteria: ["No statement holds a table lock longer than 1s"],
    settings: {
      checks: ["typecheck", "test"],
      implementer: {
        profile: { tier: "project", id: "careful-implementer" },
        backend: "codex",
        modelSelection: {
          modelId: "gpt-6-sol",
          parameters: { fast: "false", reasoning: "high" },
        },
      },
      reviewers: [
        {
          authority: "blocking",
          focus: "Data safety",
          profile: generalReviewer,
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      ],
    },
  },
  {
    key: "ui",
    scope: {
      mode: "owned",
      paths: ["src/checkout/ui", "src/checkout/copy.ts"],
    },
    dependsOn: [{ key: "plan", outputOnly: true }, "api"],
    lane: "ui",
    title: "Build the UI",
    brief:
      "Build the steps on the new API. Follow the copy in the spec; empty states point at the next action.",
    tasks: [
      { title: "Payment step" },
      { title: "Review and confirmation steps" },
      { title: "Empty and error states" },
    ],
    acceptanceCriteria: [
      "Every step works with the keyboard alone",
      "A missing payment method offers to add one",
    ],
    settings: {
      humanApproval: true,
      reviewers: [correctness, advisory("Accessibility")],
    },
  },
  {
    key: "polish",
    scope: { mode: "owned", paths: ["src/checkout/copy.ts"] },
    dependsOn: ["migrate"],
    title: "Polish copy and empty states",
    brief:
      "Bring the copy and empty states in line with the content guide. The reviewer approves when nothing is left to change.",
    tasks: [
      { title: "Apply the content guide" },
      { title: "Review every empty state" },
    ],
    acceptanceCriteria: ["Copy follows the content guide"],
    outputSchema: outputSchemaOf({ approved: z.boolean() }),
    settings: {
      checks: ["lint"],
      implementer: {
        profile: { tier: "builtin", id: "standard-agent" },
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
    },
  },
  {
    key: "integrate",
    scope: { mode: "readOnly" },
    dependsOn: ["ui", "migrate", "polish"],
    title: "Check the assembled journey",
    brief:
      "Run the full journey against the migrated schema with the flag on and off. Report what breaks.",
    tasks: [
      { title: "Journey with the flag on" },
      { title: "Journey with the flag off" },
    ],
    acceptanceCriteria: [
      "Both journeys complete; any failure is reported with its step",
    ],
    settings: { checks: ["typecheck", "lint", "test"] },
  },
  {
    key: "docs",
    scope: { mode: "owned", paths: ["docs"] },
    dependsOn: [
      { key: "api", outputOnly: true, when: { schema: publicChanges } },
      "integrate",
    ],
    title: "Update the public API docs",
    brief:
      "Update the public API reference after the assembled journey passes, when the API reports public changes.",
    tasks: [{ title: "Update the reference" }],
    settings: { reviewers: [] },
  },
];

export const checkoutTemplate: RunTemplateRecord = {
  format: 1,
  id: "checkout-rollout",
  revision: 4,
  createdAt: "2026-09-30T09:00:00.000Z",
  updatedAt: "2026-10-07T16:20:00.000Z",
  name: "Checkout rollout",
  description:
    "Ships a change behind a flag: plan, the API and UI in their own lanes, a migration, a polish loop and an integration check.",
  parameters: [
    {
      name: "flag",
      description: "Feature flag the rollout ships behind",
      required: true,
    },
  ],
  defaults: {
    implementer: {
      profile: { tier: "builtin", id: "standard-agent" },
      backend: "claude",
      modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    },
    reviewers: [correctness],
    checks: ["typecheck", "lint"],
  },
  workflow: {
    contexts,
    loops: [
      {
        key: "polish",
        body: ["polish"],
        entry: "polish",
        exit: "polish",
        until: { schema: copyApproved },
        maxPasses: 3,
      },
    ],
    lanes: [
      { key: "api", checks: ["typecheck", "test"] },
      { key: "ui", checks: ["typecheck", "lint"] },
    ],
  },
};

/** A one-context template that sets nothing: every setting is the Command Center default. */
export const quickCheckTemplate: RunTemplateRecord = {
  format: 1,
  id: "quick-check",
  revision: 1,
  createdAt: "2026-10-02T11:05:00.000Z",
  updatedAt: "2026-10-02T11:05:00.000Z",
  name: "Quick check",
  description: "One agent answers a question about the session's code.",
  parameters: [
    { name: "question", description: "What to find out", required: true },
  ],
  defaults: {},
  workflow: {
    contexts: [
      {
        key: "answer",
        scope: { mode: "readOnly" },
        brief: "Answer this about the code: {{inputs.question}}",
      },
    ],
  },
};

function summaryOf(template: RunTemplateRecord): RunTemplateSummary {
  return {
    tier: "project",
    id: template.id,
    name: template.name,
    description: template.description,
    contexts: template.workflow.contexts.length,
    parameters: template.parameters,
    revision: template.revision,
    updatedAt: template.updatedAt,
  };
}

export const templateList: RunTemplateSummary[] = [
  summaryOf(checkoutTemplate),
  summaryOf(quickCheckTemplate),
  {
    tier: "project",
    id: "two-lanes",
    description:
      "Run independent changes in parallel lanes, then check the combined result.",
    name: "Two lanes and an integration check",
    contexts: 3,
    parameters: [],
    revision: 2,
    updatedAt: "2026-09-28T09:40:00.000Z",
  },
  {
    tier: "global",
    id: "agent-reviewer",
    description:
      "One implementer and one blocking reviewer, with no workflow topology to configure.",
    name: "Agent with a blocking reviewer",
    contexts: 1,
    parameters: [{ name: "task", description: "The change", required: true }],
    revision: 3,
    updatedAt: "2026-09-20T14:12:00.000Z",
  },
  {
    tier: "global",
    id: "docs-refresh",
    description:
      "Audit the documentation, update it and verify links and examples.",
    name: "Docs refresh",
    contexts: 2,
    parameters: [],
    revision: 1,
    updatedAt: "2026-09-11T10:00:00.000Z",
  },
];

function catalogOptions(
  backend: "claude" | "codex",
): ProjectBackendModelOptions {
  const catalog = getStaticBackendModelCatalog(backend);
  return {
    backend,
    models: [...getBackendCatalogEntry(backend).models],
    defaultModelId: catalog.defaultModelId,
    source: "catalog",
    modelCatalog: catalog,
    defaultSelection: defaultSelectionForModel(catalog, catalog.defaultModelId),
    diagnostics: [],
  };
}

/** The project's model options, as `GET /api/projects/[name]/model-options` answers them. */
export const modelOptions: ProjectBackendModelOptions[] = [
  catalogOptions("claude"),
  catalogOptions("codex"),
];

function profile(
  tier: AgentProfileLibraryItem["ref"]["tier"],
  id: string,
  name: string,
): AgentProfileLibraryItem {
  return {
    ref: { tier, id },
    name,
    description: name,
    revision: 1,
    recommendedFor: [],
    tags: [],
    readOnly: tier === "builtin",
  };
}

export const profileOptions: AgentProfileLibraryItem[] = [
  profile("builtin", "standard-agent", "Standard agent"),
  profile("builtin", "general-reviewer", "General reviewer"),
  profile("project", "careful-implementer", "Careful implementer"),
];

export const validationCommands = ["typecheck", "lint", "test", "seams"];

/** The conversations a launch can make the run's owner. */
export const ownerChoices: OwnerChoice[] = [
  {
    conversationId: "c-7f3a9e21",
    title: "Release readiness review",
    backend: "claude",
    busy: false,
  },
  {
    conversationId: "c-11aa22bb",
    title: "Lane merge investigation",
    backend: "codex",
    busy: true,
  },
];
