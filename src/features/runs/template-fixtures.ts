import type {
  CatalogOption,
  ConfigBlock,
  ReviewerConfig,
  SeatConfig,
  Template,
  TemplateContext,
  TemplateSummary,
} from "./template-model";

/** The authored topology shared by the checkout run snapshots and editor stories. */

export const catalog: CatalogOption[] = [
  { backend: "claude", models: ["Opus 5.5", "Sonnet 5.5", "Haiku 4.5"] },
  { backend: "codex", models: ["GPT-6 Sol", "GPT-6 Astra"] },
];

export const efforts = ["low", "medium", "high", "xhigh", "max"];
export const profiles = [
  "builtin:standard-agent",
  "builtin:general-reviewer",
  "project:careful-implementer",
];
export const validationCommands = ["typecheck", "lint", "test", "seams"];

const opusHigh: SeatConfig = {
  backend: "claude",
  model: "Opus 5.5",
  effort: "high",
  profile: "builtin:standard-agent",
};
const correctness: ReviewerConfig = {
  id: "r-correctness",
  profile: "builtin:general-reviewer",
  authority: "blocking",
  focus: "Correctness",
  backend: "codex",
  model: "GPT-6 Sol",
  effort: "high",
};

const globals: Template["globals"] = {
  implementer: {
    backend: "claude",
    model: "Sonnet 5.5",
    effort: "medium",
    profile: "builtin:standard-agent",
  },
  reviewers: [],
  checks: ["typecheck"],
  humanApproval: false,
  ownerQuestions: true,
  unfinishedTaskRetries: 2,
  validationRetries: 2,
  captureRepairLimit: 1,
  instabilityLimit: 3,
  adviceCorrectionLimit: 1,
  timeoutMinutes: null,
};

const defaults: ConfigBlock = {
  implementer: { value: opusHigh, from: "template" },
  reviewers: { value: [correctness], from: "template" },
  checks: { value: ["typecheck", "lint"], from: "template" },
  humanApproval: { value: false, from: "global" },
  ownerQuestions: { value: true, from: "global" },
  unfinishedTaskRetries: { value: 2, from: "global" },
  validationRetries: { value: 3, from: "template" },
  captureRepairLimit: { value: 1, from: "global" },
  instabilityLimit: { value: 3, from: "global" },
  adviceCorrectionLimit: { value: 1, from: "global" },
  timeoutMinutes: { value: null, from: "global" },
};

/** A context that takes every default as it is. */
const inherited = (): ConfigBlock => ({
  implementer: { value: defaults.implementer.value, from: "template" },
  reviewers: { value: defaults.reviewers.value, from: "template" },
  checks: { value: defaults.checks.value, from: "template" },
  humanApproval: {
    value: defaults.humanApproval.value,
    from: defaults.humanApproval.from,
  },
  ownerQuestions: {
    value: defaults.ownerQuestions.value,
    from: defaults.ownerQuestions.from,
  },
  unfinishedTaskRetries: {
    value: defaults.unfinishedTaskRetries.value,
    from: defaults.unfinishedTaskRetries.from,
  },
  validationRetries: {
    value: defaults.validationRetries.value,
    from: "template",
  },
  captureRepairLimit: { ...defaults.captureRepairLimit },
  instabilityLimit: { ...defaults.instabilityLimit },
  adviceCorrectionLimit: { ...defaults.adviceCorrectionLimit },
  timeoutMinutes: { ...defaults.timeoutMinutes },
});

function context(
  fields: Omit<
    TemplateContext,
    "config" | "outputOnly" | "guards" | "scope"
  > & {
    config?: Partial<ConfigBlock>;
    outputOnly?: string[];
    guards?: Record<string, string>;
    scope?: TemplateContext["scope"];
  },
): TemplateContext {
  return {
    outputOnly: [],
    guards: {},
    scope: { mode: "full" },
    ...fields,
    config: { ...inherited(), ...fields.config },
  };
}

const contexts: TemplateContext[] = [
  context({
    key: "plan",
    scope: { mode: "readOnly" },
    title: "Plan the rollout",
    brief:
      "Read the {{flag}} spec and the current code. Return a rollout plan: the order of work, the API contract, the migration and the flag rollout.",
    tasks: [
      {
        id: "t1",
        title: "Read the spec and the current code",
        instructions: "",
      },
      { id: "t2", title: "Draft the rollout plan", instructions: "" },
      {
        id: "t3",
        title: "Return the rollout plan",
        instructions: "Include the complete plan in your closing response.",
      },
    ],
    criteria: [
      {
        id: "ac-1",
        text: "The rollout plan orders the work so the API lands before the UI uses it",
      },
      { id: "ac-2", text: "The current public API stays unchanged" },
    ],
    outputSchema: "",
    dependsOn: [],
    lane: null,
    loop: null,
    config: {
      reviewers: {
        value: [{ ...correctness, id: "r-feasibility", focus: "Feasibility" }],
        from: "context",
      },
    },
  }),
  context({
    key: "api",
    scope: { mode: "owned", paths: ["src/api", "src/orders"] },
    outputOnly: ["plan"],
    title: "Build the API",
    brief:
      "Add the endpoints described in the accepted rollout plan behind the {{flag}} flag. Keep the current handlers as they are.",
    tasks: [
      { id: "t1", title: "Add the endpoints", instructions: "" },
      { id: "t2", title: "Contract tests", instructions: "" },
      { id: "t3", title: "Publish api-contract.md", instructions: "" },
    ],
    criteria: [
      {
        id: "ac-1",
        text: "Every endpoint validates input with the shared schemas",
      },
    ],
    outputSchema:
      '{\n  "type": "object",\n  "properties": {\n    "endpoints": { "type": "array", "items": { "type": "string" } },\n    "publicChanges": { "type": "boolean" }\n  },\n  "required": ["endpoints", "publicChanges"]\n}',
    dependsOn: ["plan"],
    lane: "api",
    loop: null,
    config: {
      reviewers: {
        value: [
          correctness,
          {
            id: "r-api",
            profile: "builtin:general-reviewer",
            authority: "advisory",
            focus: "API design",
            backend: "claude",
            model: "Sonnet 5.5",
            effort: "medium",
          },
        ],
        from: "context",
      },
      checks: { value: ["typecheck", "test"], from: "context" },
    },
  }),
  context({
    key: "migrate",
    scope: { mode: "owned", paths: ["db"] },
    outputOnly: ["plan"],
    title: "Migrate the data",
    brief:
      "Add the new columns with a reversible migration. Backfill in batches; never lock the table.",
    tasks: [
      { id: "t1", title: "Write the migration", instructions: "" },
      { id: "t2", title: "Batch backfill", instructions: "" },
      { id: "t3", title: "Rollback test", instructions: "" },
    ],
    criteria: [
      { id: "ac-1", text: "No statement holds a table lock longer than 1s" },
    ],
    outputSchema: "",
    dependsOn: ["plan", "api", "ui"],
    lane: null,
    loop: null,
    config: {
      checks: { value: ["typecheck", "test"], from: "context" },
      implementer: {
        value: {
          backend: "codex",
          model: "GPT-6 Sol",
          effort: "high",
          profile: "project:careful-implementer",
        },
        from: "context",
      },
      reviewers: {
        value: [
          {
            id: "r-data",
            profile: "builtin:general-reviewer",
            authority: "blocking",
            focus: "Data safety",
            backend: "claude",
            model: "Sonnet 5.5",
            effort: "medium",
          },
        ],
        from: "context",
      },
    },
  }),
  context({
    key: "ui",
    scope: {
      mode: "owned",
      paths: ["src/checkout/ui", "src/checkout/copy.ts"],
    },
    outputOnly: ["plan"],
    title: "Build the UI",
    brief:
      "Build the steps on the new API. Follow the copy in the spec; empty states point at the next action.",
    tasks: [
      { id: "t1", title: "Payment step", instructions: "" },
      { id: "t2", title: "Review and confirmation steps", instructions: "" },
      { id: "t3", title: "Empty and error states", instructions: "" },
    ],
    criteria: [
      { id: "ac-1", text: "Every step works with the keyboard alone" },
      { id: "ac-2", text: "A missing payment method offers to add one" },
    ],
    outputSchema: "",
    dependsOn: ["plan", "api"],
    lane: "ui",
    loop: null,
    config: {
      humanApproval: { value: true, from: "context" },
      reviewers: {
        value: [
          correctness,
          {
            id: "r-a11y",
            profile: "builtin:general-reviewer",
            authority: "advisory",
            focus: "Accessibility",
            backend: "claude",
            model: "Sonnet 5.5",
            effort: "medium",
          },
        ],
        from: "context",
      },
    },
  }),
  context({
    key: "polish",
    scope: { mode: "owned", paths: ["src/checkout/copy.ts"] },
    title: "Polish copy and empty states",
    brief:
      "Bring the copy and empty states in line with the content guide. The reviewer approves when nothing is left to change.",
    tasks: [
      { id: "t1", title: "Apply the content guide", instructions: "" },
      { id: "t2", title: "Review every empty state", instructions: "" },
    ],
    criteria: [{ id: "ac-1", text: "Copy follows the content guide" }],
    outputSchema:
      '{\n  "type": "object",\n  "properties": { "approved": { "type": "boolean" } },\n  "required": ["approved"]\n}',
    dependsOn: ["migrate"],
    lane: null,
    loop: "polish",
    config: {
      checks: { value: ["lint"], from: "context" },
      implementer: {
        value: {
          backend: "claude",
          model: "Sonnet 5.5",
          effort: "medium",
          profile: "builtin:standard-agent",
        },
        from: "context",
      },
    },
  }),
  context({
    key: "integrate",
    scope: { mode: "readOnly" },
    title: "Check the assembled journey",
    brief:
      "Run the full journey against the migrated schema with the flag on and off. Report what breaks.",
    tasks: [
      { id: "t1", title: "Journey with the flag on", instructions: "" },
      { id: "t2", title: "Journey with the flag off", instructions: "" },
    ],
    criteria: [
      {
        id: "ac-1",
        text: "Both journeys complete; any failure is reported with its step",
      },
    ],
    outputSchema: "",
    dependsOn: ["ui", "migrate", "polish"],
    lane: null,
    loop: null,
    config: {
      checks: { value: ["typecheck", "lint", "test"], from: "context" },
    },
  }),
  context({
    key: "docs",
    title: "Update the public API docs",
    brief:
      "Update the public API reference after the assembled journey passes, when the API reports public changes.",
    tasks: [{ id: "t1", title: "Update the reference", instructions: "" }],
    criteria: [],
    outputSchema: "",
    dependsOn: ["api", "integrate"],
    outputOnly: ["api"],
    guards: { api: "public API changed" },
    scope: { mode: "owned", paths: ["docs"] },
    lane: null,
    loop: null,
    config: { reviewers: { value: [], from: "context" } },
  }),
];

export const checkoutTemplate: Template = {
  id: "tpl-checkout-rollout",
  name: "Checkout rollout",
  tier: "project",
  revision: 4,
  updatedAt: "2026-10-07T16:20:00.000Z",
  description:
    "Ships a change behind a flag: plan, the API and UI in their own lanes, a migration, a polish loop and an integration check.",
  parameters: [
    {
      name: "flag",
      description: "Feature flag the rollout ships behind",
      required: true,
    },
  ],
  defaults,
  globals,
  contexts,
  lanes: [
    { key: "api", checks: ["typecheck", "test"] },
    { key: "ui", checks: ["typecheck", "lint"] },
  ],
  loops: [
    {
      key: "polish",
      body: ["polish"],
      maxPasses: 3,
      until: "the copy reviewer approves",
    },
  ],
};

export const templateList: TemplateSummary[] = [
  {
    id: "tpl-checkout-rollout",
    description:
      "Plan a feature flag rollout with isolated API and UI work, then validate the assembled journey.",
    name: "Checkout rollout",
    tier: "project",
    contexts: contexts.length,
    updatedAt: "2026-10-07T16:20:00.000Z",
  },
  {
    id: "tpl-bug-fix",
    description:
      "Reproduce a defect, implement the fix and run an independent correctness review.",
    name: "Bug fix with review",
    tier: "project",
    contexts: 1,
    updatedAt: "2026-10-02T11:05:00.000Z",
  },
  {
    id: "tpl-two-lanes",
    description:
      "Run independent changes in parallel lanes, then check the combined result.",
    name: "Two lanes and an integration check",
    tier: "project",
    contexts: 3,
    updatedAt: "2026-09-28T09:40:00.000Z",
  },
  {
    id: "tpl-agent-reviewer",
    description:
      "One implementer and one blocking reviewer, with no workflow topology to configure.",
    name: "Agent with a blocking reviewer",
    tier: "global",
    contexts: 1,
    updatedAt: "2026-09-20T14:12:00.000Z",
  },
  {
    id: "tpl-docs-refresh",
    description:
      "Audit the documentation, update it and verify links and examples.",
    name: "Docs refresh",
    tier: "global",
    contexts: 2,
    updatedAt: "2026-09-11T10:00:00.000Z",
  },
];

/** The conversations a launch can make the run's owner. */
export const ownerChoices = [
  {
    conversationId: "c-7f3a9e21",
    title: "Release readiness review",
    backend: "claude" as const,
    busy: false,
  },
  {
    conversationId: "c-11aa22bb",
    title: "Lane merge investigation",
    backend: "codex" as const,
    busy: true,
  },
];
