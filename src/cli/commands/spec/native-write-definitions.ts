import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const slug = {
  name: "slug",
  description: "Canonical spec slug",
  value: { kind: "string", minLength: 1 },
} as const;
const handle = {
  name: "handle",
  description: "Bare or qualified Qn/An attention handle",
  value: { kind: "string", minLength: 1 },
} as const;
const prose = {
  value: { kind: "string", minLength: 1 },
  fileSource: { maxBytes: bytes(256 * 1024) },
} as const;
const revision = {
  description: "The exact revision id previously read",
  value: { kind: "string", minLength: 1 },
  required: true,
} as const;
const reason = {
  ...prose,
  description: "Durable reason for this transition",
  required: true,
} as const;
const recordVersion = {
  description: "Record version previously read",
  value: { kind: "integer", min: 1 },
  required: true,
} as const;
const citationVersion = {
  description: "Citation version previously read",
  value: { kind: "integer", min: 1 },
} as const;
const element = {
  description: "Related content element handle in this spec",
  value: { kind: "string", minLength: 1 },
} as const;
const execution = {
  description: "Workflow execution id (not the internal spec execution row id)",
  value: { kind: "string", minLength: 1 },
} as const;

export const specCreateSpec = {
  path: "spec create",
  summary: "Create a spec with its first draft element",
  description:
    "The file is one initial element with containment and no numeric baseElementVersion. This first save creates the durable spec.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {
    slug: {
      description: "New canonical slug",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    name: {
      description: "Spec name",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    preset: {
      description: "Gate policy preset",
      value: {
        kind: "enum",
        values: ["contract-bearing", "exploratory", "fast-path"],
      },
      required: true,
    },
  },
  payload: { maxBytes: bytes(1024 * 1024), validatePath: "spec create-check" },
} as const;
export const specCreateCommand = ccCommands.defineCommand(specCreateSpec, {
  examples: [
    {
      flags: {
        slug: "native-sdd",
        name: "Native SDD",
        preset: "contract-bearing",
      },
      file: ".cc/temp/request.json",
      why: "Create a spec with its first draft element",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-draft")).createHandler,
  }),
});

export const specImportSpec = {
  path: "spec import",
  summary: "Import a reviewed external specification",
  description:
    "Import-check rehearses server admission. The write commits a bundle with dryRun false; use import-preview to inspect the complete rehearsal.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(1024 * 1024), validatePath: "spec import-check" },
} as const;
export const specImportCommand = ccCommands.defineCommand(specImportSpec, {
  examples: [
    {
      file: ".cc/temp/request.json",
      why: "Import a reviewed external specification",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-import")).importHandler,
  }),
});

export const specImportPreviewSpec = {
  path: "spec import-preview",
  summary: "Preview an external specification import",
  description:
    "Run server validation, show counts, prospective handles and lint findings, and create no spec. Both legacy dryRun values are accepted for this read.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(1024 * 1024) },
} as const;
export const specImportPreviewCommand = ccCommands.defineCommand(
  specImportPreviewSpec,
  {
    examples: [
      {
        file: ".cc/temp/request.json",
        why: "Preview an external specification import",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-import")).importPreviewHandler,
    }),
  },
);

export const specAmendSpec = {
  path: "spec amend",
  summary: "Open an editable amendment",
  description:
    "Approved Requirements or Design opens a Design draft. Use return-to-requirements for contract changes. The server chooses the valid amendment basis and reports withdrawn revisions it skipped.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {},
} as const;
export const specAmendCommand = ccCommands.defineCommand(specAmendSpec, {
  examples: [
    { args: { slug: "native-sdd" }, why: "Open an editable amendment" },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).amendHandler,
  }),
});

export const specDraftSpec = {
  path: "spec draft",
  summary: "Write draft elements with optimistic concurrency",
  description:
    "The file is one element, an array, or {elements,removals}. Each write states baseElementVersion. The current revision comes from edit-context; batch removals and writes commit atomically.",
  related: [
    {
      path: "spec schema",
      description: "Read the exact authoring payload schema",
    },
    {
      path: "spec get",
      description: "Read an element and its current concurrency version",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    quiet: {
      description: "Return identities and versions without full payload echoes",
      value: { kind: "boolean" },
    },
  },
  payload: { maxBytes: bytes(1024 * 1024), validatePath: "spec draft-check" },
} as const;
export const specDraftCommand = ccCommands.defineCommand(specDraftSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      file: ".cc/temp/request.json",
      why: "Write draft elements with optimistic concurrency",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-draft")).draftHandler,
  }),
});

export const specRemoveSpec = {
  path: "spec remove",
  summary: "Remove addressed elements atomically",
  description:
    "Resolve every handle against one current revision and preserve each observed element version. A revision change during lookup refuses before any removal.",
  requires: "cc",
  effects: "write",
  args: [
    slug,
    {
      name: "handles",
      description: "Content handles to remove in one atomic batch",
      value: { kind: "string", minLength: 1 },
      variadic: true,
    },
  ],
  flags: {},
} as const;
export const specRemoveCommand = ccCommands.defineCommand(specRemoveSpec, {
  examples: [
    {
      args: { slug: "native-sdd", handles: ["R1", "R1.1"] },
      why: "Remove addressed elements atomically",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-draft")).removeHandler,
  }),
});

export const specProposeSpec = {
  path: "spec propose",
  summary: "Ask for review of the current draft",
  description:
    "Files the Needs You approval request and leaves the draft editable: a human can approve or comment while you keep working, and an edit to an approved subject makes it unapproved again. Under Notify or Off dials it freezes the draft instead. Notes accept inline text or --notes-file.",
  related: [
    {
      path: "spec request-approval",
      description: "Retry an approval request whose notification failed",
    },
    { path: "spec status", description: "Read the authoritative next actor" },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: { notes: { ...prose, description: "Review-round disposition notes" } },
} as const;
export const specProposeCommand = ccCommands.defineCommand(specProposeSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Ask for review of the current draft",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).proposeHandler,
  }),
});

export const specAdvanceSpec = {
  path: "spec advance",
  summary: "Advance concluded requirements into design",
  description:
    "Bind the current revision and expected requirements stage. Design is the final evergreen stage; delivery planning follows sign-off.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    from: {
      description: "Concluded authoring stage",
      value: { kind: "enum", values: ["requirements"] },
      required: true,
    },
  },
} as const;
export const specAdvanceCommand = ccCommands.defineCommand(specAdvanceSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { from: "requirements" },
      why: "Advance concluded requirements into design",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).advanceHandler,
  }),
});

export const specReturnToRequirementsSpec = {
  path: "spec return-to-requirements",
  summary: "Return design work to an editable requirements revision",
  description:
    "Use it when an amendment must change a requirement or criterion. The CLI reads the current revision and binds it as expectedRevisionId. The server withdraws that design draft, records the reason, and opens a requirements draft from the revision it amended: the approved design carries, the withdrawn draft's design edits do not.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: { reason },
} as const;
export const specReturnToRequirementsCommand = ccCommands.defineCommand(
  specReturnToRequirementsSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { reason: "Requirements need correction" },
        why: "Return design work to an editable requirements revision",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-scalar"))
        .returnToRequirementsHandler,
    }),
  },
);

export const specReplySpec = {
  path: "spec reply",
  summary: "Reply to a spec review thread",
  description:
    "Persist a reply with caller provenance and return its projected review record.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    thread: {
      description: "Review thread id",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    body: { ...prose, description: "Reply text", required: true },
  },
} as const;
export const specReplyCommand = ccCommands.defineCommand(specReplySpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { thread: "thread-one", body: "The draft now covers this case" },
      why: "Reply to a spec review thread",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).replyHandler,
  }),
});

export const specQuestionSpec = {
  path: "spec question",
  summary: "Open a question for a human decision",
  description:
    "Optional content attachment is resolved by its handle. A human records the answer in Spec Studio.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    text: {
      ...prose,
      description: "Question for the human reviewer",
      required: true,
    },
    element,
  },
} as const;
export const specQuestionCommand = ccCommands.defineCommand(specQuestionSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { text: "Which retention period should apply?" },
      why: "Open a question for a human decision",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).questionHandler,
  }),
});

export const specAnswerSpec = {
  path: "spec answer",
  summary: "Attempt to answer a spec question",
  description:
    "Resolve the open question and its version. The server enforces that answers are recorded by a human in Spec Studio.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "target",
      description: "Qualified question handle such as native-sdd/Q2",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: { answer: { ...prose, description: "Answer text", required: true } },
} as const;
export const specAnswerCommand = ccCommands.defineCommand(specAnswerSpec, {
  examples: [
    {
      args: { target: "native-sdd/Q2" },
      flags: { answer: "Ninety days" },
      why: "Attempt to answer a spec question",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).answerHandler,
  }),
});

export const specAssumeSpec = {
  path: "spec assume",
  summary: "Propose an assumption for human disposition",
  description:
    "Agents propose assumptions; a human records disposition in Spec Studio. The optional content attachment uses a handle in this spec.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    text: { ...prose, description: "Proposed assumption", required: true },
    element,
  },
} as const;
export const specAssumeCommand = ccCommands.defineCommand(specAssumeSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { text: "SQLite remains authoritative" },
      why: "Propose an assumption for human disposition",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).assumeHandler,
  }),
});

export const specAttentionEditSpec = {
  path: "spec attention edit",
  summary: "Edit a question or assumption using observed versions",
  description:
    "The strict file states question or assumption fields. Edits that change frozen premises require the observed citation version as well as record version.",
  requires: "cc",
  effects: "write",
  args: [slug, handle],
  flags: {
    "if-version": recordVersion,
    "if-citation-version": citationVersion,
  },
  payload: {
    maxBytes: bytes(1024 * 1024),
    validatePath: "spec attention edit-check",
  },
} as const;
export const specAttentionEditCommand = ccCommands.defineCommand(
  specAttentionEditSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd", handle: "Q2" },
        flags: { "if-version": 3 },
        file: ".cc/temp/request.json",
        why: "Edit a question or assumption using observed versions",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-attention")).attentionEditHandler,
    }),
  },
);

export const specAttentionWithdrawSpec = {
  path: "spec attention withdraw",
  summary: "Withdraw an attention record with a durable reason",
  description:
    "Keep history and compare against the caller record version. Withdrawing a cited assumption also requires its citation version.",
  requires: "cc",
  effects: "write",
  args: [slug, handle],
  flags: {
    reason,
    "if-version": recordVersion,
    "if-citation-version": citationVersion,
  },
} as const;
export const specAttentionWithdrawCommand = ccCommands.defineCommand(
  specAttentionWithdrawSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd", handle: "Q2" },
        flags: { reason: "Question is superseded", "if-version": 3 },
        why: "Withdraw an attention record with a durable reason",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-attention"))
        .attentionWithdrawHandler,
    }),
  },
);

export const specAttentionSupersedeSpec = {
  path: "spec attention supersede",
  summary: "Create the durable successor of an assumption",
  description:
    "The file names an operation id, reason, successor text, attachment, and citation policy. Preserve both observed concurrency tokens.",
  requires: "cc",
  effects: "write",
  args: [slug, handle],
  flags: {
    "if-version": recordVersion,
    "if-citation-version": { ...citationVersion, required: true },
  },
  payload: {
    maxBytes: bytes(1024 * 1024),
    validatePath: "spec attention supersede-check",
  },
} as const;
export const specAttentionSupersedeCommand = ccCommands.defineCommand(
  specAttentionSupersedeSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd", handle: "A2" },
        flags: { "if-version": 4, "if-citation-version": 2 },
        file: ".cc/temp/request.json",
        why: "Create the durable successor of an assumption",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-attention"))
        .attentionSupersedeHandler,
    }),
  },
);

export const specAttentionCiteSpec = {
  path: "spec attention cite",
  summary: "Cite an assumption against a draft content element",
  description:
    "The caller supplies the exact draft revision and citation version. Only content elements in this spec may be cited.",
  requires: "cc",
  effects: "write",
  args: [slug, handle],
  flags: {
    element: { ...element, required: true },
    revision,
    "if-citation-version": { ...citationVersion, required: true },
  },
} as const;
export const specAttentionCiteCommand = ccCommands.defineCommand(
  specAttentionCiteSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd", handle: "A2" },
        flags: {
          element: "R1",
          revision: "revision-one",
          "if-citation-version": 2,
        },
        why: "Cite an assumption against a draft content element",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-attention")).attentionCiteHandler,
    }),
  },
);

export const specAttentionUnciteSpec = {
  path: "spec attention uncite",
  summary: "Remove a draft citation of an assumption",
  description:
    "The caller supplies the exact draft revision and citation version; the durable attention record remains.",
  requires: "cc",
  effects: "write",
  args: [slug, handle],
  flags: {
    element: { ...element, required: true },
    revision,
    "if-citation-version": { ...citationVersion, required: true },
  },
} as const;
export const specAttentionUnciteCommand = ccCommands.defineCommand(
  specAttentionUnciteSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd", handle: "A2" },
        flags: {
          element: "R1",
          revision: "revision-one",
          "if-citation-version": 2,
        },
        why: "Remove a draft citation of an assumption",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-attention"))
        .attentionUnciteHandler,
    }),
  },
);

export const specRequestApprovalSpec = {
  path: "spec request-approval",
  summary: "Request human review of a gate or subject",
  description:
    "Requesting never approves; only a human can sign off in Spec Studio. The receipt distinguishes a committed request from uncertain delivery of its human notification.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    gate: {
      description: "Gate to route for human review",
      value: {
        kind: "enum",
        values: [
          "requirements",
          "design",
          "plan",
          "execution_start",
          "delivery",
        ],
      },
      required: true,
    },
    subject: {
      description: "Optional review subject; omission requests the whole gate",
      value: { kind: "string", minLength: 1 },
    },
  },
} as const;
export const specRequestApprovalCommand = ccCommands.defineCommand(
  specRequestApprovalSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { gate: "requirements" },
        why: "Request human review of a gate or subject",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-scalar")).requestApprovalHandler,
    }),
  },
);

export const specStartSpec = {
  path: "spec start",
  summary: "Launch the approved delivery candidate with ordinary inputs",
  description:
    "The mandatory file holds ordinary launch parameter values, or {} when none are needed. It never supplies an execution graph: the approved candidate is the graph. Requires a concrete session. Start-check performs input and identity checks without launch.",
  related: [
    {
      path: "spec capture",
      description: "Record discovered work during execution",
    },
    {
      path: "spec abandon",
      description: "Retire an execution whose pinned scope is obsolete",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    park: {
      description:
        "Park the candidate for prelaunch review without creating an execution",
      value: { kind: "boolean" },
    },
  },
  payload: { maxBytes: bytes(1024 * 1024), validatePath: "spec start-check" },
} as const;
export const specStartCommand = ccCommands.defineCommand(specStartSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      file: ".cc/temp/request.json",
      why: "Launch the approved delivery candidate with ordinary inputs",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-delivery")).startHandler,
  }),
});

export const specCaptureSpec = {
  path: "spec capture",
  summary: "Capture discovered work without changing pinned scope",
  description:
    "The task file omits kind. A blocking reason abandons the run and opens a replacement attempt; otherwise discovery is queued for a later plan. The receipt states which path occurred.",
  related: [
    {
      path: "spec plan open",
      description: "Open a later delivery attempt for queued discoveries",
    },
    {
      path: "spec abandon",
      description: "Retire a blocking run before replacement",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    execution,
    "blocking-reason": {
      ...prose,
      description:
        "Durable reason to abandon this run and open its replacement",
    },
  },
  payload: { maxBytes: bytes(1024 * 1024), validatePath: "spec capture-check" },
} as const;
export const specCaptureCommand = ccCommands.defineCommand(specCaptureSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      file: ".cc/temp/request.json",
      why: "Capture discovered work without changing pinned scope",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-delivery")).captureHandler,
  }),
});

export const specRenameSpec = {
  path: "spec rename",
  summary: "Rename a spec while preserving its alias",
  description: "The server returns the canonical spec and the old slug alias.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {
    to: {
      description: "New canonical spec slug",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    name: {
      description: "Optional new display name",
      value: { kind: "string", minLength: 1 },
    },
  },
} as const;
export const specRenameCommand = ccCommands.defineCommand(specRenameSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { to: "native-specs" },
      why: "Rename a spec while preserving its alias",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).renameHandler,
  }),
});

export const specAbandonSpec = {
  path: "spec abandon",
  summary: "Abandon one workflow execution or request spec retirement",
  description:
    "Execution ids are the workflow ids from start. Retiring a whole spec is human-only; the CLI preserves the server refusal.",
  related: [
    {
      path: "workflow live abort",
      description: "Recover an execution retirement that did not finish",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: { execution, reason },
} as const;
export const specAbandonCommand = ccCommands.defineCommand(specAbandonSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      flags: { execution: "workflow-one", reason: "Scope superseded" },
      why: "Abandon one workflow execution or request spec retirement",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-scalar")).abandonHandler,
  }),
});

export const specPlanOpenSpec = {
  path: "spec plan open",
  summary: "Open a delta-seeded delivery attempt",
  description:
    "The server pins the approved revision and returns its coverage ledger, draft revision, and next actor.",
  related: [
    {
      path: "workflow validate",
      description: "Validate the authored managed workflow document",
    },
    {
      path: "workflow replace",
      description: "Replace the managed draft graph",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {},
} as const;
export const specPlanOpenCommand = ccCommands.defineCommand(specPlanOpenSpec, {
  examples: [
    {
      args: { slug: "native-sdd" },
      why: "Open a delta-seeded delivery attempt",
    },
  ],
  handler: async () => ({
    default: (await import("./native-write-delivery")).planOpenHandler,
  }),
});

export const specPlanProposeSpec = {
  path: "spec plan propose",
  summary: "Ask for review of the delivery plan draft",
  description:
    "Checks the draft against the sign-off gate. When execution start needs a human, nothing changes: the human reviews the draft and signs it off in Builder. Under Notify or Off it freezes and signs the launch envelope, and the receipt names the candidate id and hash that launch binds to.",
  related: [
    {
      path: "spec plan status",
      description: "Read who acts next and the Builder review link",
    },
    {
      path: "spec start",
      description: "Launch the signed candidate with input parameters",
    },
  ],
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: {},
} as const;
export const specPlanProposeCommand = ccCommands.defineCommand(
  specPlanProposeSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        why: "Ask for review of the delivery plan draft",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-delivery")).planProposeHandler,
    }),
  },
);

export const specPlanReopenSpec = {
  path: "spec plan reopen",
  summary: "Reopen delivery planning and invalidate candidate approval",
  description:
    "The server records the reason and returns the new draft revision and approval ledger.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: { reason },
} as const;
export const specPlanReopenCommand = ccCommands.defineCommand(
  specPlanReopenSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { reason: "Coverage needs correction" },
        why: "Reopen delivery planning and invalidate candidate approval",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-delivery")).planReopenHandler,
    }),
  },
);

export const specPlanAbandonSpec = {
  path: "spec plan abandon",
  summary: "Retire a delivery attempt before launch",
  description:
    "Record why the unlaunched attempt is retired. A fresh plan open pins the current approved revision.",
  requires: "cc",
  effects: "write",
  args: [slug],
  flags: { reason },
} as const;
export const specPlanAbandonCommand = ccCommands.defineCommand(
  specPlanAbandonSpec,
  {
    examples: [
      {
        args: { slug: "native-sdd" },
        flags: { reason: "Pinned scope is superseded" },
        why: "Retire a delivery attempt before launch",
      },
    ],
    handler: async () => ({
      default: (await import("./native-write-delivery")).planAbandonHandler,
    }),
  },
);

export const specWriteCommands = [
  specCreateCommand,
  specImportCommand,
  specImportPreviewCommand,
  specAmendCommand,
  specDraftCommand,
  specRemoveCommand,
  specProposeCommand,
  specAdvanceCommand,
  specReturnToRequirementsCommand,
  specReplyCommand,
  specQuestionCommand,
  specAnswerCommand,
  specAssumeCommand,
  specAttentionEditCommand,
  specAttentionWithdrawCommand,
  specAttentionSupersedeCommand,
  specAttentionCiteCommand,
  specAttentionUnciteCommand,
  specRequestApprovalCommand,
  specStartCommand,
  specCaptureCommand,
  specRenameCommand,
  specAbandonCommand,
  specPlanOpenCommand,
  specPlanProposeCommand,
  specPlanReopenCommand,
  specPlanAbandonCommand,
] as const;
export const specWriteGroups = [
  defineGroup({
    path: "spec attention",
    summary: "Maintain questions, assumptions, and draft citations",
    description:
      "Preserve record and citation versions while editing durable attention records.",
  }),
  defineGroup({
    path: "spec plan",
    summary: "Author and review delivery candidates",
    description:
      "Open, propose, inspect, and explicitly retire or reopen managed delivery attempts.",
  }),
] as const;
