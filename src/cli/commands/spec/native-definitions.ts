import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const slug = {
  name: "slug",
  description: "Canonical spec slug",
  value: { kind: "string", minLength: 1 },
} as const;
const revision = {
  description: "Revision id or number; defaults to the current revision",
  value: { kind: "string", minLength: 1 },
} as const;
export const specStatusSpec = {
  path: "spec status",
  summary: "Read lifecycle gates and delivery progress",
  description:
    "Read the authoring revision, editable objects and revision guards, pinned delivery attempt, and next actor with review links. Collections are bounded; full returns every row. Executing may mean a parked review or a completed lane waiting for its merge.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {},
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specShowSpec = {
  path: "spec show",
  summary: "Read a spec's current outline or full content",
  description:
    "Default returns the bounded current-revision outline. Summary returns counts. Rendered exports canonical Markdown; full exports the complete typed detail. The library owns artifact delivery and --out.",
  requires: "cc",
  effects: "read",
  output: "binary",
  args: [slug],
  flags: {},
  levels: {
    summary: { output: "bounded" },
    rendered: { output: "artifact-eligible" },
    full: { output: "artifact-eligible" },
  },
} as const;
export const specListSpec = {
  path: "spec list",
  summary: "List the project's specs",
  description: "Read each spec's identity and lifecycle phase.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
} as const;
export const specMeasuresSpec = {
  path: "spec measures",
  summary: "Read spec quality and delivery measures",
  description:
    "Read requirement rework, approval friction, traceability, automatic evidence capture, and navigation chains.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
} as const;
export const specCommentsSpec = {
  path: "spec comments",
  summary: "Read spec review threads",
  description:
    "Read review comments and blocking/open thread counts, optionally filtered by element or open state.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    element: {
      description: "Element handle",
      value: { kind: "string", minLength: 1 },
    },
    open: { description: "Only open threads", value: { kind: "boolean" } },
  },
} as const;
export const specLintSpec = {
  path: "spec lint",
  summary: "Read the draft's lint findings",
  description:
    "Read findings grouped by the transitions they block. A successful lint read exits successfully even when findings block proposal.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {},
} as const;
export const specGetSpec = {
  path: "spec get",
  summary: "Read one addressed spec element",
  description:
    "Read <slug>/<handle> or <slug> <handle> with complete content and revision tokens. Historical-only elements return a recovery instruction.",
  requires: "cc",
  effects: "read",
  args: [
    {
      name: "target",
      description: "Qualified handle, or slug when followed by a handle",
      value: { kind: "string", minLength: 1 },
    },
    {
      name: "handle",
      description: "Bare handle when target is a slug",
      value: { kind: "string", minLength: 1 },
      required: false,
    },
  ],
  flags: { revision },
} as const;
export const specSectionGetSpec = {
  path: "spec section get",
  summary: "Read a handle-less section by id",
  description:
    "Sections have no handle. Use the stable element id returned by spec show; the response includes its full content and revision tokens.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    id: {
      description: "Stable section element id",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    revision,
  },
} as const;
export const specSearchSpec = {
  path: "spec search",
  summary: "Search one spec or the whole project",
  description:
    "Pass <slug> <query> to search one spec, or --all <query> to search every spec in the project.",
  requires: "cc",
  effects: "read",
  args: [
    {
      name: "target",
      description: "Spec slug, or query when --all is selected",
      value: { kind: "string", minLength: 1 },
    },
    {
      name: "query",
      description: "Query text for one-spec search",
      value: { kind: "string", minLength: 1 },
      required: false,
    },
  ],
  flags: {
    all: {
      description: "Search all project specs",
      value: { kind: "boolean" },
    },
  },
} as const;

export const specDiffSpec = {
  path: "spec diff",
  summary: "Compare spec revisions",
  description:
    "Compare the current revision with its immediate review base, a named base, or the nearest approved governance ancestor.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    from: revision,
    to: revision,
    baseline: {
      description: "Compare with the nearest approved ancestor",
      value: { kind: "enum", values: ["governance"] },
    },
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specDeltaSpec = {
  path: "spec delta",
  summary: "Read changes since delivery",
  description:
    "Read element changes, criterion freshness, and advisories against a delivered execution. Full returns all rows and allows --out.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    since: {
      description: "Execution id to compare against",
      value: { kind: "string", minLength: 1 },
    },
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specExportSpec = {
  path: "spec export",
  summary: "Export a canonical spec bundle",
  description:
    "Write exact canonical bundle JSON through the library artifact protocol. Use --stdout to return bundle data inline, subject to the normal output budget.",
  requires: "cc",
  effects: "read",
  output: "binary",
  args: [slug],
  flags: {
    stdout: {
      description: "Return the bundle in the response data",
      value: { kind: "boolean" },
    },
  },
} as const;
export const specVerifySpec = {
  path: "spec verify",
  summary: "Verify content and lifecycle integrity",
  description:
    "Fail on hash mismatches or unresolved consistency findings, retaining each finding's remedy. Optionally compare a canonical local export before continuing.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    against: {
      description: "Canonical bundle JSON to compare",
      value: { kind: "string", minLength: 1 },
    },
  },
} as const;
export const specPlanGetSpec = {
  path: "spec plan get",
  summary: "Read the authored delivery plan",
  description:
    "Read a bounded plan summary and coverage claims. Full returns the complete authored document.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {},
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specPlanStatusSpec = {
  path: "spec plan status",
  summary: "Read delivery plan obligations",
  description:
    "Read the binding ledger, unresolved criteria, lint findings, review state, and who acts next. Full returns all findings and snapshots.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {},
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specPlanPreviewSpec = {
  path: "spec plan preview",
  summary: "Read the authored or frozen launch candidate",
  description:
    "Draft reads editable content and is never approvable. Proposed reads the immutable candidate that a human approval binds to. Outline returns a navigation map of its graph.",
  requires: "cc",
  effects: "read",
  args: [slug],
  flags: {
    stage: {
      description: "Editable draft or frozen proposed candidate",
      value: { kind: "enum", values: ["draft", "proposed"] },
      required: true,
    },
    "expected-draft-revision": {
      description: "Expected editable draft revision; applies only to draft",
      value: { kind: "integer", min: 1 },
    },
    outline: {
      description: "Return graph navigation instead of the launch content",
      value: { kind: "boolean" },
    },
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;

export const specSchemaSpec = {
  path: "spec schema",
  summary: "Read generated authoring schemas offline",
  description:
    "List accepted input documents or read one generated schema, its example, and authoring-stage constraints. These shapes come from the same domain schemas the server validates.",
  requires: "none",
  effects: "read",
  args: [
    {
      name: "document",
      description: "Document id from the schema index",
      value: { kind: "string", minLength: 1 },
      required: false,
    },
  ],
  flags: {},
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const specSchemaCommand = ccCommands.defineCommand(specSchemaSpec, {
  examples: [
    {
      args: { document: "requirement" },
      why: "Prepare a requirement document without a server",
    },
  ],
  handler: async () => ({
    default: (await import("./native-schema")).schemaHandler,
  }),
});

export const specListCommand = ccCommands.defineCommand(specListSpec, {
  examples: [{ why: "Find current specs before starting new work" }],
  handler: async () => ({
    default: (await import("./native-read")).listHandler,
  }),
});
export const specMeasuresCommand = ccCommands.defineCommand(specMeasuresSpec, {
  examples: [{ why: "Inspect current project evidence and review measures" }],
  handler: async () => ({
    default: (await import("./native-read")).measuresHandler,
  }),
});
export const specCommentsCommand = ccCommands.defineCommand(specCommentsSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { open: true },
      why: "Read unresolved review threads",
    },
  ],
  handler: async () => ({
    default: (await import("./native-read")).commentsHandler,
  }),
});
export const specLintCommand = ccCommands.defineCommand(specLintSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Inspect findings before proposing a revision",
    },
  ],
  handler: async () => ({
    default: (await import("./native-read")).lintHandler,
  }),
});
export const specGetCommand = ccCommands.defineCommand(specGetSpec, {
  examples: [
    {
      args: { target: "native-sdd/R1" },
      why: "Read one requirement before editing it",
    },
  ],
  handler: async () => ({
    default: (await import("./native-read")).getHandler,
  }),
});
export const specSectionGetCommand = ccCommands.defineCommand(
  specSectionGetSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { id: "section-one" },
        why: "Read a section without inventing a handle",
      },
    ],
    handler: async () => ({
      default: (await import("./native-read")).sectionGetHandler,
    }),
  },
);
export const specSearchCommand = ccCommands.defineCommand(specSearchSpec, {
  examples: [
    {
      args: { target: "authentication" },
      flags: { all: true },
      why: "Find existing work throughout the project",
    },
  ],
  handler: async () => ({
    default: (await import("./native-read")).searchHandler,
  }),
});
export const specStatusCommand = ccCommands.defineCommand(specStatusSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Read what can happen next and which gates remain",
    },
  ],
  handler: async () => ({
    default: (await import("./native-views")).statusHandler,
  }),
});
export const specShowCommand = ccCommands.defineCommand(specShowSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Find the handles and sections to read next",
    },
  ],
  handler: async () => ({
    default: (await import("./native-views")).showHandler,
  }),
});
export const specDiffCommand = ccCommands.defineCommand(specDiffSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Compare current content with its review base",
    },
  ],
  handler: async () => ({
    default: (await import("./native-analysis")).diffHandler,
  }),
});
export const specDeltaCommand = ccCommands.defineCommand(specDeltaSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Find work changed since the last delivery",
    },
  ],
  handler: async () => ({
    default: (await import("./native-analysis")).deltaHandler,
  }),
});
export const specExportCommand = ccCommands.defineCommand(specExportSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Save a complete canonical verification bundle",
    },
  ],
  handler: async () => ({
    default: (await import("./native-analysis")).exportHandler,
  }),
});
export const specVerifyCommand = ccCommands.defineCommand(specVerifySpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Check content and unresolved lifecycle findings",
    },
  ],
  handler: async () => ({
    default: (await import("./native-analysis")).verifyHandler,
  }),
});
export const specPlanGetCommand = ccCommands.defineCommand(specPlanGetSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Read the current authored delivery plan",
    },
  ],
  handler: async () => ({
    default: (await import("./native-plan")).planGetHandler,
  }),
});
export const specPlanStatusCommand = ccCommands.defineCommand(
  specPlanStatusSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        why: "Read the acts needed before plan approval",
      },
    ],
    handler: async () => ({
      default: (await import("./native-plan")).planStatusHandler,
    }),
  },
);
export const specPlanPreviewCommand = ccCommands.defineCommand(
  specPlanPreviewSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { stage: "draft" },
        why: "Inspect an editable launch candidate",
      },
    ],
    handler: async () => ({
      default: (await import("./native-plan")).planPreviewHandler,
    }),
  },
);
export const specCommands = [
  specSchemaCommand,
  specListCommand,
  specMeasuresCommand,
  specCommentsCommand,
  specLintCommand,
  specGetCommand,
  specSectionGetCommand,
  specSearchCommand,
  specStatusCommand,
  specShowCommand,
  specDiffCommand,
  specDeltaCommand,
  specExportCommand,
  specVerifyCommand,
  specPlanGetCommand,
  specPlanStatusCommand,
  specPlanPreviewCommand,
] as const;
export const specGroups = [
  defineGroup({
    path: "spec",
    summary: "Author and inspect native specifications",
    description:
      "Read requirements, design, review state, and delivery evidence; server policy governs every transition.",
  }),
  defineGroup({
    path: "spec section",
    summary: "Read handle-less sections",
    description:
      "Address sections using the stable element ids from spec show.",
  }),
] as const;
