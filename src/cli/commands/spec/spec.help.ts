import type { CommandHelpEntry } from "../../help-types";

export const specHelpEntries: CommandHelpEntry[] = [
  {
    path: ["spec"],
    summary: "author, review, execute, and verify durable specs",
    description:
      "Read and mutate native Command Center specs through the typed agent surface. Specs have stable slugs, immutable approved revisions, server-enforced gates, and criterion-level evidence.",
    usage: [
      "cctl spec list",
      "cctl spec measures",
      "cctl spec show <slug>",
      "cctl spec status <slug>",
      "cctl spec get <slug>/<handle>",
      "cctl spec search <slug> <query>",
      "cctl spec export <slug> [--out <bundle.json>]",
      "cctl spec verify <slug> [--against <bundle.json>]",
      "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>",
      "cctl spec draft <slug> --file <element.json> --base-version <number|new>",
      "cctl spec propose <slug>",
      "cctl spec advance <slug> --from <requirements|design>",
      "cctl spec question <slug> --text <text> [--element <handle>]",
      "cctl spec answer <slug>/Q2 --answer <text>",
      "cctl spec assume <slug> --text <text> [--element <handle>]",
      "cctl spec task complete <slug>/T7 --execution <id> --evidence <id>",
      "cctl spec start <slug> --file <scope.json>",
      "cctl spec capture <slug> --execution <id> --file <task.json>",
    ],
    flags: [],
    examples: [],
    domainContext:
      "A slug identifies the durable spec across renames through aliases. Element handles are R3, R3.2, D2, T7, Q2, or A1; qualify them as <slug>/<handle> when no slug argument is present.",
    related: [
      { command: "spec show", oneLiner: "read a spec's current full view" },
      {
        command: "spec status",
        oneLiner: "inspect lifecycle gates, approvals, questions, and coverage",
      },
      {
        command: "spec create",
        oneLiner: "create a durable spec from its first draft save",
      },
      { command: "spec draft", oneLiner: "save a base-versioned element" },
      {
        command: "spec measures",
        oneLiner: "inspect pilot measures and reviewer navigation chains",
      },
    ],
  },
  {
    path: ["spec", "list"],
    summary: "list native specs in the current project",
    description:
      "List the current project's durable spec inventory with each spec's phase and approval summary.",
    usage: ["cctl spec list"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec list --json",
        explanation: "return the typed inventory in the shared JSON envelope",
      },
    ],
    related: [
      { command: "spec show", oneLiner: "read one listed spec" },
      { command: "spec search", oneLiner: "search within one listed spec" },
    ],
  },
  {
    path: ["spec", "measures"],
    summary: "compute native SDD pilot measures",
    description:
      "Compute requirement-caused rework, approval friction, traceability completeness, and automatic evidence capture from retained events. The response includes the frozen definitions version and criterion-level reviewer navigation chains.",
    usage: ["cctl spec measures"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec measures --json",
        explanation:
          "return all four measures, their definitions version, and navigation chains",
      },
    ],
    related: [
      { command: "spec list", oneLiner: "inspect the measured spec inventory" },
      {
        command: "spec status",
        oneLiner: "inspect one spec's lifecycle and coverage",
      },
    ],
  },
  {
    path: ["spec", "show"],
    summary: "read a spec's full or summary view",
    description:
      "Read the current full spec view, including revisions, current content, and status. Pass --summary for counts and approval state without element content.",
    usage: ["cctl spec show <slug> [--summary]"],
    flags: [
      {
        name: "summary",
        kind: "boolean",
        description: "return the compact summary view instead of full content",
      },
    ],
    examples: [
      {
        invocation: "cctl spec show native-sdd --summary --json",
        explanation: "read compact counts, phase, revision, and approval state",
      },
    ],
    related: [
      { command: "spec list", oneLiner: "discover spec slugs" },
      { command: "spec status", oneLiner: "inspect lifecycle readiness" },
      { command: "spec get", oneLiner: "read one element with proof state" },
      { command: "spec export", oneLiner: "write the canonical bundle" },
    ],
  },
  {
    path: ["spec", "status"],
    summary: "inspect a spec's phase and gate readiness",
    description:
      "Show phase, current authoring stage and its concluding gate, every gate state, pending approvals, open questions, criterion coverage, and the task execution graph for one spec.",
    usage: ["cctl spec status <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec status native-sdd --json",
        explanation: "return all readiness fields without reading full prose",
      },
    ],
    related: [
      { command: "spec show", oneLiner: "read the full current spec" },
      { command: "spec get", oneLiner: "inspect one pending element" },
      { command: "spec verify", oneLiner: "recompute revision integrity" },
      {
        command: "spec advance",
        oneLiner: "explicitly conclude a Notify/Off authoring stage",
      },
    ],
  },
  {
    path: ["spec", "get"],
    summary: "read one spec element with approval and evidence state",
    description:
      "Read one requirement, criterion, decision, or task, or a question/assumption record by its Q/A handle. Use a qualified handle, or pass the slug and a bare handle as separate arguments.",
    usage: ["cctl spec get <slug>/<handle>", "cctl spec get <slug> <handle>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec get native-sdd/R3.2 --json",
        explanation:
          "read the criterion plus its approval, evidence, verdict, and waiver state",
      },
    ],
    related: [
      { command: "spec show", oneLiner: "read the surrounding spec" },
      { command: "spec status", oneLiner: "inspect aggregate readiness" },
      {
        command: "spec search",
        oneLiner: "find a requirement or decision handle",
      },
    ],
  },
  {
    path: ["spec", "search"],
    summary: "search requirement and decision text",
    description:
      "Search the current spec revision's requirements and decisions by text and return matching handles.",
    usage: ["cctl spec search <slug> <query>"],
    flags: [],
    examples: [
      {
        invocation: 'cctl spec search native-sdd "delivery gate" --json',
        explanation:
          "find matching requirements and decisions without loading the full spec",
      },
    ],
    related: [
      { command: "spec list", oneLiner: "discover spec slugs" },
      { command: "spec show", oneLiner: "read the full matching spec" },
      { command: "spec get", oneLiner: "read one matched handle" },
    ],
  },
  {
    path: ["spec", "export"],
    summary: "produce a canonical portable spec bundle",
    description:
      "Export canonical revision markdown plus the manifest. Without --out the bundle prints to stdout; --out writes one JSON bundle file.",
    usage: ["cctl spec export <slug> [--out <bundle.json>]"],
    flags: [
      {
        name: "out",
        kind: "value",
        valuePlaceholder: "<bundle.json>",
        description: "write the canonical bundle to this UTF-8 JSON file",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec export native-sdd --out .cc/temp/native-sdd.json",
        explanation:
          "write a portable representation suitable for later verification",
      },
    ],
    related: [
      {
        command: "spec verify",
        oneLiner: "verify integrity against an export",
      },
      { command: "spec show", oneLiner: "read the live full view" },
    ],
  },
  {
    path: ["spec", "verify"],
    summary: "recompute spec integrity",
    description:
      "Recompute immutable revision hashes. With --against, validate the bundle locally before network and compare it with the current canonical export.",
    usage: ["cctl spec verify <slug> [--against <bundle.json>]"],
    flags: [
      {
        name: "against",
        kind: "value",
        valuePlaceholder: "<bundle.json>",
        description: "compare current canonical content with this prior export",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec verify native-sdd --against .cc/temp/native-sdd.json --json",
        explanation:
          "verify both stored hashes and the supplied portable representation",
      },
    ],
    related: [
      { command: "spec export", oneLiner: "write a fresh canonical bundle" },
      { command: "spec status", oneLiner: "inspect lifecycle readiness" },
    ],
  },
  {
    path: ["spec", "create"],
    summary: "create a durable spec from its first draft save",
    description:
      "Create the stable spec object atomically with its first saved element: no durable spec exists until this first successful draft save. A taken slug refuses with slug_taken; an approved spec with no open draft opens an amendment carrying the element.",
    usage: [
      "cctl spec create --slug <slug> --name <name> --preset <contract-bearing|exploratory|fast-path> --file <element.json>",
    ],
    flags: [
      {
        name: "slug",
        kind: "value",
        valuePlaceholder: "<slug>",
        description: "stable lowercase kebab-case spec identity",
      },
      {
        name: "name",
        kind: "value",
        valuePlaceholder: "<name>",
        description: "human-readable spec name",
      },
      {
        name: "preset",
        kind: "value",
        valuePlaceholder: "<preset>",
        description: "initial gate-policy preset",
      },
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<element.json>",
        description:
          "schema-backed first element saved in the same transaction",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec create --slug audit-log --name "Audit log" --preset contract-bearing --file .cc/temp/R1.json --json',
        explanation:
          "create the durable object, its editable revision, and the first element in one save",
      },
    ],
    related: [
      { command: "spec draft", oneLiner: "save subsequent content elements" },
      { command: "spec show", oneLiner: "read the created object" },
    ],
  },
  {
    path: ["spec", "draft"],
    summary: "save a base-versioned draft element",
    description:
      "Upsert one element admitted by the current authoring stage into the editable revision. Use the version last read, or new when creating the element; stale writes return the winning content and version.",
    usage: [
      "cctl spec draft <slug> --file <element.json> --base-version <number|new>",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<element.json>",
        description: "schema-backed element write document",
      },
      {
        name: "base-version",
        kind: "value",
        valuePlaceholder: "<number|new>",
        description: "compare-and-swap version observed by the author",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec draft audit-log --file .cc/temp/R1.json --base-version 3 --json",
        explanation:
          "save an edited element only if version 3 is still current",
      },
    ],
    domainContext:
      "Requirements stage admits intent/context prose, requirements, and criteria; design additionally admits decisions and design narrative; plan additionally admits tasks. Plan each task for one agent lane, treat dependencies as ordering truth and missing paths as parallelism claims, split oversized work before saving, and declare laneGroup/touchedPaths where they communicate reviewed execution intent.",
    related: [
      { command: "spec get", oneLiner: "read the current element version" },
      {
        command: "spec propose",
        oneLiner: "propose the current authoring stage",
      },
      {
        command: "spec create",
        oneLiner: "create the spec with its first element",
      },
    ],
  },
  {
    path: ["spec", "propose"],
    summary: "propose the current authoring stage for review",
    description:
      "Freeze the editable revision and enter review for its current authoring stage. Blocking lint findings are returned as structured issues with an immediate instruction; do not pre-author the next stage while review is pending.",
    usage: ["cctl spec propose <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec propose audit-log --json",
        explanation:
          "propose the current draft or receive its blocking findings",
      },
    ],
    related: [
      { command: "spec draft", oneLiner: "resolve findings in the draft" },
      {
        command: "spec request-approval",
        oneLiner: "route the proposed gate to the user",
      },
    ],
  },
  {
    path: ["spec", "advance"],
    summary: "conclude a Notify/Off authoring stage explicitly",
    description:
      "Advance the current draft from the expected requirements or design stage when that stage's concluding dial is Notify or Off. Gate requires human review and sign-off instead; stale revision or stage expectations are refused without changing content.",
    usage: ["cctl spec advance <slug> --from <requirements|design>"],
    flags: [
      {
        name: "from",
        kind: "value",
        valuePlaceholder: "<requirements|design>",
        description:
          "authoring stage observed on the current draft and expected to conclude",
      },
    ],
    examples: [
      {
        invocation: "cctl spec advance audit-log --from requirements --json",
        explanation:
          "record the policy admission and advance the same draft to design",
      },
    ],
    related: [
      { command: "spec status", oneLiner: "read the current stage and dial" },
      {
        command: "spec propose",
        oneLiner: "enter review when the concluding dial is Gate",
      },
      {
        command: "spec draft",
        oneLiner: "author content admitted by the stage",
      },
    ],
  },
  {
    path: ["spec", "question"],
    summary: "open a visible spec question for human answer",
    description:
      "Record a durable question on the spec so it stays visible in spec status and Spec Studio until answered. Optionally attach it to a requirement, criterion, decision, or task handle.",
    usage: ["cctl spec question <slug> --text <text> [--element <handle>]"],
    flags: [
      {
        name: "text",
        kind: "value",
        valuePlaceholder: "<text>",
        description: "question that blocks or shapes the spec content",
      },
      {
        name: "element",
        kind: "value",
        valuePlaceholder: "<handle>",
        description: "optional bare or qualified related element handle",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec question audit-log --text "Which retention period applies?" --element R1',
        explanation: "open Q<n> attached to requirement R1",
      },
    ],
    related: [
      { command: "spec answer", oneLiner: "answer an open question" },
      { command: "spec assume", oneLiner: "propose a reviewable assumption" },
      { command: "spec status", oneLiner: "list open question handles" },
    ],
  },
  {
    path: ["spec", "answer"],
    summary: "answer an open spec question",
    description:
      "Resolve a visible question record by its qualified Q handle. The answer remains durable in spec review state.",
    usage: ["cctl spec answer <slug>/Q2 --answer <text>"],
    flags: [
      {
        name: "answer",
        kind: "value",
        valuePlaceholder: "<text>",
        description: "answer to persist on the question",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec answer audit-log/Q2 --answer "Retain events for 90 days"',
        explanation: "answer the exact open question shown by spec status",
      },
    ],
    related: [
      { command: "spec status", oneLiner: "list open question handles" },
      { command: "spec assume", oneLiner: "propose a reviewable assumption" },
    ],
  },
  {
    path: ["spec", "assume"],
    summary: "propose a visible authoring assumption",
    description:
      "Record an assumption for human disposition. Optionally associate it with a requirement, criterion, decision, or task handle.",
    usage: ["cctl spec assume <slug> --text <text> [--element <handle>]"],
    flags: [
      {
        name: "text",
        kind: "value",
        valuePlaceholder: "<text>",
        description: "assumption proposed by the authoring agent",
      },
      {
        name: "element",
        kind: "value",
        valuePlaceholder: "<handle>",
        description: "optional bare or qualified related element handle",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec assume audit-log --text "SQLite remains authoritative" --element R1',
        explanation: "attach a visible assumption to requirement R1",
      },
    ],
    related: [
      { command: "spec answer", oneLiner: "answer an open question" },
      { command: "spec status", oneLiner: "inspect current review state" },
    ],
  },
  {
    path: ["spec", "task"],
    summary: "act on an approved spec task",
    description: "Task mutations operate on qualified T handles.",
    usage: [
      "cctl spec task complete <slug>/T7 --execution <id> --evidence <id>",
    ],
    flags: [],
    examples: [],
    domainContext:
      "Author each plan-stage task for one agent lane and split work that cannot be completed or reviewed independently. Treat dependencies as ordering truth and independent tasks as explicit parallelism claims. Declare normalized touchedPaths so conflicting surfaces are visible, and use laneGroup only when several small tasks intentionally share one execution context.",
    related: [
      {
        command: "spec task complete",
        oneLiner: "claim evidence-backed completion",
      },
      { command: "spec get", oneLiner: "read task criterion coverage" },
    ],
  },
  {
    path: ["spec", "task", "complete"],
    summary: "claim task completion with evidence",
    description:
      "Claim an approved task complete inside an execution. Repeat --evidence for each durable evidence reference; the server refuses evidence-less or insufficient claims.",
    usage: [
      "cctl spec task complete <slug>/T7 --execution <id> --evidence <evidence-id> [--evidence <evidence-id> ...]",
    ],
    flags: [
      {
        name: "execution",
        kind: "value",
        valuePlaceholder: "<id>",
        description: "spec execution receiving the completion claim",
      },
      {
        name: "evidence",
        kind: "value",
        valuePlaceholder: "<evidence-id>",
        repeatable: true,
        description: "durable evidence reference supporting covered criteria",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec task complete audit-log/T7 --execution exec-1 --evidence evidence-8 --evidence evidence-9 --json",
        explanation:
          "submit a claim with all criterion-level evidence references",
      },
    ],
    related: [
      { command: "spec get", oneLiner: "inspect task proof state" },
      { command: "spec status", oneLiner: "inspect execution readiness" },
    ],
  },
  {
    path: ["spec", "request-approval"],
    summary: "route a spec gate to the user",
    description:
      "Create durable attention for a human-controlled gate. Agents can request approval but cannot approve, sign off, or change policy.",
    usage: [
      "cctl spec request-approval <slug> --gate <gate> [--subject <handle-or-label>]",
    ],
    flags: [
      {
        name: "gate",
        kind: "value",
        valuePlaceholder: "<gate>",
        description: "requirements, design, plan, execution_start, or delivery",
      },
      {
        name: "subject",
        kind: "value",
        valuePlaceholder: "<handle-or-label>",
        description: "exact review subject for Needs You navigation",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec request-approval audit-log --gate requirements --subject R1",
        explanation: "route requirement R1 to the human review surface",
      },
    ],
    related: [
      { command: "spec status", oneLiner: "inspect pending approvals" },
      { command: "spec propose", oneLiner: "freeze the revision for review" },
    ],
  },
  {
    path: ["spec", "start"],
    summary: "start execution from an approved revision and scope",
    description:
      "Validate a scope document locally, then compile the approved revision and selected tasks and criteria into an execution workflow.",
    usage: ["cctl spec start <slug> --file <scope.json>"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<scope.json>",
        description: "task/criterion selections and all exclusion dispositions",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec start audit-log --file .cc/temp/audit-scope.json --json",
        explanation: "validate the complete scope before any server request",
      },
    ],
    related: [
      { command: "spec status", oneLiner: "verify execution-start readiness" },
      { command: "spec abandon", oneLiner: "abandon an execution with reason" },
      {
        command: "spec capture",
        oneLiner: "capture work discovered while the execution runs",
      },
    ],
  },
  {
    path: ["spec", "capture"],
    summary: "capture discovered work as a proposed scope amendment",
    description:
      "Record work discovered during a running execution as a task on a draft amendment revision based on the run's pinned revision. The run's pinned scope never changes; the amendment queues for a future execution. With --blocking-reason the running execution is abandoned in the same operation (abandon-and-restart).",
    usage: [
      "cctl spec capture <slug> --execution <id> --file <task.json> [--blocking-reason <reason>]",
    ],
    flags: [
      {
        name: "execution",
        kind: "value",
        valuePlaceholder: "<id>",
        description: "running execution the work was discovered in",
      },
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<task.json>",
        description:
          "discovered task document: title, instructions, four trace id arrays, and optional laneGroup/touchedPaths",
      },
      {
        name: "blocking-reason",
        kind: "value",
        valuePlaceholder: "<reason>",
        description:
          "the discovery blocks this run — abandon it with this durable reason",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec capture audit-log --execution exec-1 --file .cc/temp/discovered-task.json --json",
        explanation:
          'task.json shape: {"title": "...", "instructions": "...", "tracedRequirementElementIds": [], "tracedDecisionElementIds": [], "coveredCriterionElementIds": [], "dependsOnTaskElementIds": [], "laneGroup": "optional", "touchedPaths": ["src/lib"]} — the id arrays may be empty at capture time',
      },
    ],
    domainContext:
      "Capture is refused unless the execution is running. Populate coveredCriterionElementIds before proposing the amendment, or criterion-coverage lint will block propose.",
    related: [
      {
        command: "spec start",
        oneLiner: "start a future execution from the amended revision",
      },
      {
        command: "spec abandon",
        oneLiner: "abandon the execution without capturing work",
      },
      {
        command: "spec status",
        oneLiner: "inspect the draft amendment revision",
      },
    ],
  },
  {
    path: ["spec", "rename"],
    summary: "rename a spec's slug, keeping the old slug as an alias",
    description:
      "Rename the durable spec to a new slug and optionally a new name. The prior slug is written to the alias table in the same transaction, so previously copied references and deep links keep resolving. Renaming is a human act: agent transports receive a typed human_act_required refusal — ask the operator to rename from Spec Studio.",
    usage: ["cctl spec rename <slug> --to <new-slug> [--name <name>]"],
    flags: [
      {
        name: "to",
        kind: "value",
        valuePlaceholder: "<new-slug>",
        description: "new stable lowercase kebab-case spec slug",
      },
      {
        name: "name",
        kind: "value",
        valuePlaceholder: "<name>",
        description: "optional new human-readable spec name",
      },
    ],
    examples: [
      {
        invocation: "cctl spec rename audit-log --to audit-trail --json",
        explanation:
          "rename the spec while audit-log keeps resolving through its alias",
      },
    ],
    related: [
      { command: "spec show", oneLiner: "read the spec by either slug" },
      { command: "spec list", oneLiner: "inspect the renamed inventory" },
    ],
  },
  {
    path: ["spec", "abandon"],
    summary: "abandon a spec or one of its executions",
    description:
      "Record a required durable reason while abandoning the whole spec, or target one execution with --execution.",
    usage: [
      "cctl spec abandon <slug> --reason <reason>",
      "cctl spec abandon <slug> --execution <id> --reason <reason>",
    ],
    flags: [
      {
        name: "execution",
        kind: "value",
        valuePlaceholder: "<id>",
        description: "abandon this execution instead of the whole spec",
      },
      {
        name: "reason",
        kind: "value",
        valuePlaceholder: "<reason>",
        description: "required durable abandonment reason",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec abandon audit-log --execution exec-1 --reason "Scope superseded"',
        explanation: "stop one execution while preserving the durable spec",
      },
    ],
    related: [
      { command: "spec start", oneLiner: "start an approved scoped execution" },
      { command: "spec status", oneLiner: "inspect current lifecycle state" },
      {
        command: "spec capture",
        oneLiner: "capture blocking discovered work, then abandon and restart",
      },
    ],
  },
];
