import type { CommandHelpEntry } from "../../help-types";
import { NATIVE_SDD_GUIDANCE_SECTIONS } from "@/lib/specs/native-sdd-guidance";

export const specHelpEntries: CommandHelpEntry[] = [
  {
    path: ["spec"],
    summary: "author, review, execute, and verify durable specs",
    description:
      "Read and mutate native Command Center specs through the typed agent surface. Specs have stable slugs, immutable approved revisions, server-enforced gates, and criterion-level evidence. Gate policy — the per-gate Gate/Notify/Off dials — is changeable, but only by a human in Spec Studio; agent transports receive a typed human_act_required refusal.",
    usage: [
      "cctl spec list",
      "cctl spec measures",
      "cctl spec show <slug>",
      "cctl spec status <slug>",
      "cctl spec comments <slug> [--element <handle>] [--open]",
      "cctl spec reply <slug> --thread <threadId> --body <text>",
      "cctl spec lint <slug>",
      "cctl spec get <slug>/<handle>",
      "cctl spec search <slug> <query>",
      "cctl spec search --all <query>",
      "cctl spec diff <slug> [--from <revisionId>] [--to <revisionId>] [--baseline governance]",
      "cctl spec schema [<document>]",
      "cctl spec delta <slug> [--since <executionId>] [--out <delta.json>]",
      "cctl spec export <slug> [--out <bundle.json>] [--stdout]",
      "cctl spec verify <slug> [--against <bundle.json>]",
      "cctl spec create --slug <slug> --name <name> --preset <preset> --file <element.json>",
      "cctl spec import --file <bundle.json> [--dry-run]",
      "cctl spec amend <slug>",
      "cctl spec draft <slug> --file <element.json>",
      "cctl spec remove <slug> <handle...>",
      "cctl spec propose <slug>",
      "cctl spec advance <slug> --from <requirements>",
      "cctl spec question <slug> --text <text> [--element <handle>]",
      "cctl spec answer <slug>/Q2 --answer <text>",
      "cctl spec assume <slug> --text <text> [--element <handle>]",
      "cctl spec plan open <slug> [--seed-from last]",
      "cctl spec plan edit <slug> --file <plan.json>",
      "cctl spec plan propose <slug>",
      "cctl spec plan reopen <slug> --reason <why>",
      "cctl spec plan get <slug>",
      "cctl spec plan status <slug>",
      "cctl spec plan preview <slug> --stage draft|proposed",
      "cctl spec plan sign-off <slug>",
      "cctl spec start <slug> [--inputs .cc/temp/inputs.json] [--park]",
      "cctl spec capture <slug> --file <task.json>",
    ],
    flags: [],
    examples: [],
    domainContext:
      "A slug identifies the durable spec across renames through aliases. Element handles are R3, R3.2, D2, T7, Q2, or A1; qualify them as <slug>/<handle> when no slug argument is present.",
    related: [
      {
        command: "spec show",
        oneLiner: "navigate a spec's bounded current-revision outline",
      },
      {
        command: "spec status",
        oneLiner: "inspect lifecycle gates, approvals, questions, and coverage",
      },
      {
        command: "spec lint",
        oneLiner: "read what would refuse propose before attempting it",
      },
      {
        command: "spec create",
        oneLiner: "create a durable spec from its first draft save",
      },
      {
        command: "spec amend",
        oneLiner: "reopen authoring on a spec whose gate was approved",
      },
      {
        command: "spec draft",
        oneLiner: "save an element at the version it replaces",
      },
      {
        command: "spec remove",
        oneLiner: "take draft elements out by the handle you address them by",
      },
      {
        command: "spec measures",
        oneLiner: "inspect pilot measures and reviewer navigation chains",
      },
      {
        command: "spec delta",
        oneLiner: "see what changed since the last delivery",
      },
      {
        command: "spec plan",
        oneLiner: "author the delivery plan that becomes the executed graph",
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
    summary: "inspect a bounded spec outline or write a detailed artifact",
    description:
      "Read a bounded nested outline of the current revision by default. Pass --summary for counts only, --rendered for canonical Markdown, or --full for the raw detail projection. Summary and outline name what they omitted and the exact next command. Rendered and full views are written under .cc/temp/ by default and stdout returns a small artifact receipt; --out selects another file. If a summary or outline still exceeds the hard stdout budget, its exact envelope moves to a JSON artifact and stdout returns a storage: artifact receipt.",
    usage: [
      "cctl spec show <slug> [--summary]",
      "cctl spec show <slug> --rendered [--out <file>]",
      "cctl spec show <slug> --full [--out <file>]",
    ],
    flags: [
      {
        name: "summary",
        kind: "boolean",
        description: "return counts and approval state only",
      },
      {
        name: "rendered",
        kind: "boolean",
        description: "write the current revision as canonical Markdown",
      },
      {
        name: "full",
        kind: "boolean",
        description: "write the complete raw detail projection as JSON",
      },
      {
        name: "out",
        kind: "value",
        description: "write --rendered or --full content to this path",
      },
    ],
    examples: [
      {
        invocation: "cctl spec show native-sdd",
        explanation:
          "read the bounded current-revision outline with requirements, nested criteria, statuses, and omission counts",
      },
      {
        invocation: "cctl spec show native-sdd --rendered",
        explanation:
          "write canonical Markdown under .cc/temp/ and receive its path, size, and hash",
      },
      {
        invocation:
          "cctl spec show native-sdd --full --out /tmp/native-sdd.json --json",
        explanation:
          "write the raw detail projection to an explicit file and serialize the bounded receipt as JSON",
      },
    ],
    domainContext:
      "--json changes serialization only; it does not change or widen the selected disclosure level. The default outline is server-bounded and reports total, returned, and truncated for each collection plus the exact --rendered follow-up. Criteria are nested under their requirements even though durable position remains one global revision order.",
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
      "Show phase, current authoring stage and its concluding gate, the authoring stages the open draft still has to walk, every gate state with why it is or is not consulted for the current revision, the subject approvals still outstanding, whether a proposed revision still owes an explicit human sign-off, a lint findings tier, open questions, criterion coverage, and the task execution graph for one spec. Each active execution is reported with its lane position: running, parked with no workflow lane launched, or parked awaiting human approval of the finalized candidate. The enumerated sections are bounded to ten rows each and say what they left out; --full returns every row, and past the stdout budget either level is written to a .cc/temp file whose manifest stdout carries instead.",
    usage: ["cctl spec status <slug> [--full] [--json]"],
    flags: [
      {
        name: "full",
        kind: "boolean",
        description:
          "every row of each enumerated section, instead of the bounded ten",
      },
    ],
    examples: [
      {
        invocation: "cctl spec status native-sdd --json",
        explanation:
          "the bounded readiness projection, with per-section total/returned/truncated under disclosure",
      },
      {
        invocation: "cctl spec status native-sdd --full",
        explanation:
          "every open question, assumption, approval, execution, and plan task the bounded sections capped",
      },
    ],
    domainContext:
      "The remaining-stage sequence is pinned to the open draft, not derived from the current preset: a policy change never moves an open draft's stage, so a draft opened under one preset keeps walking its own sequence under the new dials. Each remaining stage names the gate that concludes it and whether that concluding step is an advance or a propose. Gate applicability is measured against the nearest APPROVED ancestor, so a gate stays consulted for content that entered through an attempt a human withdrew, and an earlier admission is reported as history rather than as current satisfaction. The findings tier names counts per severity and the first few findings; the enumerated sections — executions, pending subject approvals, open questions, assumptions, plan tasks — are bounded to ten items each and state what they left out in both renderings, and --full is what returns the rest.",
    related: [
      {
        command: "spec show",
        oneLiner: "navigate the bounded current-revision outline",
      },
      { command: "spec get", oneLiner: "inspect one pending element" },
      {
        command: "spec lint",
        oneLiner: "read the full finding panel behind the tier",
      },
      { command: "spec verify", oneLiner: "recompute revision integrity" },
      {
        command: "spec propose",
        oneLiner: "freeze the current authoring stage for review",
      },
      {
        command: "spec advance",
        oneLiner: "explicitly conclude a Notify/Off authoring stage",
      },
      {
        command: "spec amend",
        oneLiner: "open the next draft once a stage's gate is approved",
      },
      {
        command: "spec comments",
        oneLiner: "read the review comments behind the open-comment counts",
      },
    ],
  },
  {
    path: ["spec", "comments"],
    summary: "read reviewer comments as typed rows",
    description:
      "List the review comments humans left in Spec Studio, projected for agent consumption: each row names the commented element by handle, the quoted text the comment anchors to, the body, whether it blocks sign-off, and its thread and resolution state. This is the feedback half of the review loop — approvals answer 'may this land', comments answer 'what does the reviewer want changed or explained'.",
    usage: ["cctl spec comments <slug> [--element <handle>] [--open]"],
    flags: [
      {
        name: "element",
        kind: "value",
        description: "only comments on this element (handle or element id)",
      },
      {
        name: "open",
        kind: "boolean",
        description: "only comments still awaiting resolution",
      },
    ],
    examples: [
      {
        invocation: "cctl spec comments ephemeral-workflows --open --json",
        explanation:
          "read the outstanding review feedback as data after status reports open comments",
      },
      {
        invocation: "cctl spec comments ephemeral-workflows --element R6",
        explanation: "read every comment thread anchored to R6",
      },
    ],
    domainContext:
      "Comments are written by humans reviewing a proposed revision; openCount and openBlockingCount are spec-wide even when --element or --open narrows the listed rows, so a filtered read still reports how much feedback is outstanding. Comments do not reopen the draft: repairing a commented element needs the human to Request Changes in Spec Studio first, and status names that dependency when it applies.",
    related: [
      {
        command: "spec status",
        oneLiner: "the readiness view that counts these comments",
      },
      {
        command: "spec get",
        oneLiner: "inspect the commented element itself",
      },
      {
        command: "spec reply",
        oneLiner: "answer a thread in place",
      },
      {
        command: "spec propose",
        oneLiner: "carry your answers back in the next revision's notes",
      },
    ],
  },
  {
    path: ["spec", "reply"],
    summary: "answer a review thread in place",
    description:
      "Join an existing review thread with a reply. The thread comes from `cctl spec comments`; the reply lands beside the reviewer's comment with your conversation as its author, carries the thread's own anchor, and never blocks anything. Replying does not resolve the thread and does not reopen the draft — repairs still need a human to Request Changes in Spec Studio.",
    usage: ["cctl spec reply <slug> --thread <threadId> --body <text>"],
    flags: [
      {
        name: "thread",
        kind: "value",
        description: "the threadId a spec comments row names",
      },
      {
        name: "body",
        kind: "value",
        fileSource: true,
        description: "the reply text",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec reply ephemeral-workflows --thread thread-7f3a --body "R6 excludes retries because the workflow engine already owns them; happy to fold them in if you disagree."',
        explanation:
          "answer the reviewer's question inside the thread that asked it",
      },
    ],
    domainContext:
      "A reply is conversation, not review: it is admitted from an agent or a human whenever the thread is still open, on proposed and reopened-draft revisions alike. An ended (resolved or dismissed) thread refuses replies — answer in the next proposal's notes instead.",
    related: [
      {
        command: "spec comments",
        oneLiner: "list the threads and their ids",
      },
      {
        command: "spec status",
        oneLiner: "see whether feedback is still outstanding",
      },
    ],
  },
  {
    path: ["spec", "lint"],
    summary: "read every deterministic lint finding on the open draft",
    description:
      "Print the whole finding panel for the editable revision, grouped by severity, with the subset that would refuse propose flagged as such. This is the same deterministic lint the propose refusal runs and Spec Studio's lint tab renders — reading it here is how an author learns what the draft owes BEFORE attempting the transition, rather than discovering it as a refusal. Findings name the element they are about by handle and carry the rule that produced them. A draft with no findings says so; a draft whose only findings are advisory can be proposed.",
    usage: ["cctl spec lint <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec lint native-sdd",
        explanation:
          "read every finding grouped by severity before proposing the draft",
      },
      {
        invocation: "cctl spec lint native-sdd --json",
        explanation:
          "take the counts, the per-severity groups, and the linted revision id as data",
      },
    ],
    generatedReference: [NATIVE_SDD_GUIDANCE_SECTIONS.evergreenLint],
    domainContext:
      "Severities say which act a finding refuses: blocks_propose refuses propose outright, blocks_signoff refuses the revision sign-off, and advisory refuses nothing. The linted revision is the open draft when one exists and the current revision otherwise, so the verb answers for the same content propose would judge. `cctl spec status` carries a counts-and-top-findings tier over this same panel.",
    related: [
      {
        command: "spec propose",
        oneLiner: "the transition the blocking findings refuse",
      },
      {
        command: "spec status",
        oneLiner: "the findings tier and the rest of readiness",
      },
      {
        command: "spec draft",
        oneLiner: "fix a finding by re-saving the element it names",
      },
    ],
  },
  {
    path: ["spec", "get"],
    summary: "read one spec element with approval and evidence state",
    description:
      "Read one requirement, criterion, decision, or task, or a question/assumption record by its Q/A handle. Text mode is a complete line-oriented field view; --json wraps the same selected element under the named element payload. Use a qualified handle, or pass the slug and a bare handle as separate arguments.",
    usage: ["cctl spec get <slug>/<handle>", "cctl spec get <slug> <handle>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec get native-sdd/R3.2",
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
    summary: "search requirement and decision text in one spec or across all",
    description:
      "Search requirement and decision text on the current revision. With a slug it searches that one spec; with --all it searches every spec in the project and returns each hit's slug, name, phase, preset, and match summary. A project-wide hit whose slug or name matched counts even with no element matches.",
    usage: [
      "cctl spec search <slug> <query>",
      "cctl spec search --all <query>",
    ],
    flags: [
      {
        name: "all",
        kind: "boolean",
        description:
          "search every spec in the project instead of one named spec",
      },
    ],
    examples: [
      {
        invocation: 'cctl spec search native-sdd "delivery gate" --json',
        explanation:
          "find matching requirements and decisions without loading the full spec",
      },
      {
        invocation: 'cctl spec search --all "audit log" --json',
        explanation:
          "check whether any spec already covers this ground before creating a competing one",
      },
    ],
    related: [
      { command: "spec list", oneLiner: "read the full project inventory" },
      {
        command: "spec show",
        oneLiner: "navigate the matching spec's bounded outline",
      },
      { command: "spec get", oneLiner: "read one matched handle" },
      {
        command: "spec create",
        oneLiner: "create a spec once no existing one covers the work",
      },
      {
        command: "spec import",
        oneLiner:
          "bring an external spec in whole once no existing one covers the work",
      },
    ],
  },
  {
    path: ["spec", "diff"],
    summary: "read the semantic changelog between two revisions",
    description:
      "Classify every element of one revision against a base as added, modified, removed, or unchanged, with a one-line summary of each change. Without flags it compares the current proposal (or open draft) against its immediate review base — the same pair Spec Studio's review cards diff, so the CLI classes and the surface a human signs off on cannot disagree. A modified acceptance criterion also marks its requirement modified, reported as an indirect change.",
    usage: [
      "cctl spec diff <slug>",
      "cctl spec diff <slug> --baseline governance",
      "cctl spec diff <slug> --from <revisionId> --to <revisionId>",
    ],
    flags: [
      {
        name: "from",
        kind: "value",
        valuePlaceholder: "<revisionId>",
        description: "compare against this revision instead of the review base",
      },
      {
        name: "to",
        kind: "value",
        valuePlaceholder: "<revisionId>",
        description:
          "compare this revision instead of the current one; draft, proposed, and approved revisions all work",
      },
      {
        name: "baseline",
        kind: "value",
        valuePlaceholder: "governance",
        description:
          "compare against the governance base (nearest approved ancestor) instead of the immediate review base; names a base, so it cannot be combined with --from",
      },
    ],
    examples: [
      {
        invocation: "cctl spec diff native-sdd",
        explanation:
          "read what this proposal changed before hunting through the full revision",
      },
      {
        invocation: "cctl spec diff native-sdd --baseline governance --json",
        explanation:
          "see everything still unadmitted by a human, including content that entered through a withdrawn attempt",
      },
    ],
    domainContext:
      "The immediate review base is `basedOnRevisionId`; the governance base is the nearest APPROVED ancestor, which gate applicability is measured against. They differ whenever an attempt was withdrawn or is still under review, so the base is never swapped silently — --baseline governance is the explicit way to ask for the other one.",
    related: [
      {
        command: "spec show",
        oneLiner: "use --full to write the revision ids --from/--to take",
      },
      { command: "spec status", oneLiner: "inspect gate and sign-off state" },
      {
        command: "spec get",
        oneLiner: "read one changed element in full",
      },
    ],
  },
  {
    path: ["spec", "schema"],
    summary: "list offline input and response contract documents",
    description:
      "List the offline contract documents, or name one to print its JSON Schema, enumerated values, constraints, worked example, and semantic notes. Input shapes come from the schemas production parses; guidance comes from typed registries; `read-envelopes` documents response payload fields and revision roles. Runs entirely offline — no server, no project.",
    usage: ["cctl spec schema", "cctl spec schema <document>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec schema criterion",
        explanation:
          "read the criterion write document's shape, its evidence-kind enum, and a payload you can copy",
      },
      {
        invocation: "cctl spec schema create-element",
        explanation:
          "read the document `cctl spec create` takes — the same element without a baseElementVersion, because the revision it opens has no version to compare against",
      },
      {
        invocation: "cctl spec schema import-bundle",
        explanation:
          "read the whole-spec document `cctl spec import` takes, with a worked example covering every artifact a bundle can carry",
      },
      {
        invocation: "cctl spec schema read-envelopes",
        explanation:
          "read named response payloads and the exact base/current/approved revision semantics",
      },
      {
        invocation: "cctl spec schema guidance",
        explanation:
          "read the graph-owned admission boundary and both lint taxonomies from the registries production uses",
      },
    ],
    domainContext:
      "Element position is one global order per revision, sorted by position then elementId; omit position on create to append and on update to keep the current slot. Nesting comes from parentElementId alone, never from position, and duplicate positions are accepted and resolved by the elementId tiebreak.",
    related: [
      {
        command: "spec draft",
        oneLiner: "save an element written to this shape",
      },
      {
        command: "spec create",
        oneLiner: "create a spec from a first element of this shape",
      },
      {
        command: "spec import",
        oneLiner: "create a whole spec from a bundle of this shape",
      },
      {
        command: "spec start",
        oneLiner:
          "launch only after authoring and approving a delivery-plan attempt",
      },
      {
        command: "spec capture",
        oneLiner: "pass the discovered-task document",
      },
    ],
  },
  {
    path: ["spec", "delta"],
    summary: "compare the approved spec against a delivered execution",
    description:
      "Report what changed since a delivery and what that costs the next plan. Elements are classified added/amended/unchanged/removed by stable element id and immutable payload hash; criteria are classified delivered-and-fresh, soft-stale, hard-stale, never-delivered, deferred, or waived against the compared execution's pinned revision. This is the authoring input for the next execution's delivery plan: the criterion classes are the dispositions that plan owes, and the advisories name the ones a delivered_elsewhere disposition cannot legally carry. Nothing is written or persisted. Per-class listings are capped at 30 rows with total/shown/omitted counts and ordered by handle; --out writes the complete projection JSON.",
    usage: [
      "cctl spec delta <slug> [--since <executionId>] [--out <delta.json>]",
    ],
    flags: [
      {
        name: "since",
        kind: "value",
        valuePlaceholder: "<executionId>",
        description:
          "compare against this execution instead of the last delivered one",
      },
      {
        name: "out",
        kind: "value",
        valuePlaceholder: "<delta.json>",
        description:
          "write the complete projection to this UTF-8 JSON file, uncapped",
      },
    ],
    examples: [
      {
        invocation: "cctl spec delta native-sdd",
        explanation:
          "see what the last delivery no longer covers before authoring the next plan",
      },
      {
        invocation:
          "cctl spec delta native-sdd --since exec-4f2a --out .cc/temp/delta.json",
        explanation:
          "compare against a specific run and keep the full classification for the plan author",
      },
    ],
    domainContext:
      "Classification never reads elementVersion, which resets each revision; it compares immutable payload hashes at the two pinned revisions. Hard-stale means the criterion's own text or validation strategy changed, so its old proof proved different words and it must be re-proved. Soft-stale means the criterion is unchanged but its parent requirement or a decision that governed that requirement at the pinned revision changed, which one reaffirmation clears.",
    related: [
      {
        command: "spec status",
        oneLiner: "list this spec's executions to pick a --since id",
      },
      {
        command: "spec start",
        oneLiner: "launch the execution this delta is authoring toward",
      },
      {
        command: "spec show",
        oneLiner:
          "use --full to write the approved snapshot the delta compares",
      },
    ],
  },
  {
    path: ["spec", "export"],
    summary: "write a canonical portable spec bundle",
    description:
      "Export canonical revision markdown plus the manifest. Without flags the bundle is WRITTEN to .cc/temp/<slug>-spec-bundle.json and stdout carries only its manifest: revision count, element count, content hash, and the written path. --out writes the same bundle to a path you name. Inlining the bundle into stdout now requires --stdout. This default changed on 2026-08-07 (approved compatibility break); a script that read the bundle from stdout has to pass --stdout.",
    usage: [
      "cctl spec export <slug>",
      "cctl spec export <slug> --out <bundle.json>",
      "cctl spec export <slug> --stdout",
    ],
    flags: [
      {
        name: "out",
        kind: "value",
        valuePlaceholder: "<bundle.json>",
        description:
          "write the canonical bundle to this UTF-8 JSON file instead of the derived path",
      },
      {
        name: "stdout",
        kind: "boolean",
        description:
          "print the bundle itself to stdout and write no file (the pre-2026-08-07 default)",
      },
    ],
    examples: [
      {
        invocation: "cctl spec export native-sdd",
        explanation:
          "write the bundle to .cc/temp/native-sdd-spec-bundle.json and read back its revision count, element count, content hash, and path",
      },
      {
        invocation:
          "cctl spec export native-sdd --out .cc/temp/native-sdd.json",
        explanation:
          "write a portable representation suitable for later verification",
      },
      {
        invocation: "cctl spec export native-sdd --stdout --json",
        explanation:
          "inline the bundle for a caller that pipes it instead of storing it",
      },
    ],
    domainContext:
      "The destination default does not transform the bundle: a file this command writes contains the same canonical format 3 bytes that --stdout emits. Format 3 renders parents before their children. `cctl spec verify --against` reports an older format as bundle_format_mismatch and directs the caller to export a fresh bundle; ordinary content drift remains integrity_mismatch. The content hash covers the exact current bytes, so two exports of unchanged content report the same hash.",
    related: [
      {
        command: "spec verify",
        oneLiner: "verify integrity against an export",
      },
      {
        command: "spec show",
        oneLiner: "use --full to write the live raw detail view",
      },
    ],
  },
  {
    path: ["spec", "verify"],
    summary: "recompute spec integrity and report consistency findings",
    description:
      "Recompute immutable revision hashes, and report the consistency findings hashes cannot see: an abandonment whose cleanup never finished, a run still holding the session's execution slot after its spec execution was abandoned, and live proposals an approved revision forked past. A hash or same-format content mismatch exits with integrity_mismatch; an older canonical bundle exits with bundle_format_mismatch and directs the caller to export a fresh bundle; clean hashes with outstanding findings exit with spec_inconsistent, and each finding names the exact act that disposes of it. With --against, validate the bundle locally before network and compare it with the current canonical export.",
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
      "Create the stable spec object atomically with its first saved element: no durable spec exists until this first successful draft save. A taken slug refuses with slug_taken. On an approved spec with no open draft this still opens an amendment carrying the element, but reach for `cctl spec amend <slug>` when continuing an existing spec — create is for a spec that does not exist yet.",
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
          "schema-backed first element saved in the same transaction — run `cctl spec schema create-element` for its shape; it needs no baseElementVersion because the revision it opens holds no version to compare against (an explicit null is tolerated, a number is refused)",
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
      {
        command: "spec schema",
        oneLiner:
          "print the create-element document's schema and a worked example",
      },
      {
        command: "spec amend",
        oneLiner: "continue authoring a spec that already exists",
      },
      { command: "spec show", oneLiner: "read the created object" },
      {
        command: "spec import",
        oneLiner: "create a whole spec at once from an external source",
      },
    ],
  },
  {
    path: ["spec", "import"],
    summary: "create a new spec in one act from an external source bundle",
    description:
      'Translate an external spec — a Kiro directory, an RFC, a design doc, anything you can read — into one bundle document and import it as a new native spec. The spec is born approved at the design stage on IMPORT PROVENANCE: the revision records that an agent imported it and from which source, and no approval row of any kind is written, so every human gate on it stays exactly as strong as on a spec authored here. Delivery is the same kind of testimony — `delivered` records that the external source shipped, and the delivery gate never reads it. Import creates new specs ONLY: a taken slug or alias refuses with slug_taken, including one an abandoned spec holds, and there is no revival or amendment path through this verb. Refusals: slug_taken for a taken slug; lint_blocked with the same findings a propose would return, because an import is a propose and an approval in one act; validation for a bundle that misses the schema, declares one requirement ref twice, traces a ref no requirement declares, or claims delivery with no acceptance criterion to record it against — that last one clears by giving the bundle a criterion or by setting `"delivered": false`. Nothing is written on any refusal.',
    usage: [
      "cctl spec import --file <bundle.json>",
      "cctl spec import --file <bundle.json> --dry-run",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<bundle.json>",
        description:
          "the whole import in one document — slug, name, source label, sections, requirements with criteria, decisions, questions, assumptions, and the delivered flag. Run `cctl spec schema import-bundle` for its generated schema and a worked example covering every artifact; the document is refused locally against that schema before any request.",
      },
      {
        name: "dry-run",
        kind: "boolean",
        description:
          'rehearse instead of importing: run every validation the real import runs, report the findings and the handles it would allocate, and write nothing. The bundle may also set `"dryRun": true` itself; either asking rehearses, and neither cancels the other\'s request — so a bundle that declares it rehearses on every invocation of this command, and only `"dryRun": false` in the document (or dropping the field) performs the import.',
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec import --file .cc/temp/bundle.json --dry-run --json",
        explanation:
          "rehearse first: read the blocking findings and the R/D/Q/A numbering the import would allocate, so cross-references in the bundle can be written against real handles",
      },
      {
        invocation: "cctl spec import --file .cc/temp/bundle.json --json",
        explanation:
          "perform the import and read back the created slug, its approved revision, and whether an external delivery was recorded",
      },
    ],
    domainContext:
      "This is the only way a spec enters Command Center already past its authoring gates. Import is for content that has never been in CC at all. Handles are allocated in bundle order — requirements R1…Rn, criteria numbered within each requirement, decisions D1…Dn, questions Q1…Qn, assumptions A1…An — and decisions trace requirements by a bundle-local `ref` the importer resolves to real element ids. The receipt names what to do next: `cctl spec show <slug>` for a delivered import, which owes nothing further, and `cctl spec plan open <slug>` for one that has not shipped and still owes delivery here.",
    related: [
      {
        command: "spec list",
        oneLiner: "check whether the slug is already taken before importing",
      },
      {
        command: "spec search",
        oneLiner: "find whether this content already exists as a spec here",
      },
      {
        command: "spec amend",
        oneLiner: "change a spec that already exists — import never will",
      },
      {
        command: "spec schema",
        oneLiner: "print the import-bundle schema and its worked example",
      },
      {
        command: "spec plan open",
        oneLiner: "author delivery for an imported spec that has not shipped",
      },
      { command: "spec show", oneLiner: "read the imported spec back" },
    ],
  },
  {
    path: ["spec", "amend"],
    summary: "reopen authoring on an approved spec as an amendment draft",
    description:
      "Open the editable draft on a spec whose latest revision is approved, so authoring continues without mutating immutable approved content. This is authoring continuation after a gate is approved — to record work discovered inside a running execution use `cctl spec capture` instead. The action is idempotent: an already-open draft is returned unchanged, and a slug with no spec behind it refuses with not_found. A spec whose revision is proposed refuses with revision_in_review: amending would number a new revision above the one being reviewed while carrying none of its content, so conclude the review first — human sign-off in Spec Studio, a human requesting changes on that revision, or, if this conversation proposed it and no human has acted on it yet, `cctl spec withdraw-proposal <slug> --revision <revision-id>`.",
    usage: ["cctl spec amend <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec amend audit-log --json",
        explanation:
          "reopen evergreen authoring after a revision was approved, then read the returned revision number and authoring stage",
      },
    ],
    domainContext:
      "The active evergreen sequence ends at design. An amendment after approved requirements opens at design; an amendment after approved design or a legacy approved plan revision also opens at design. Legacy task elements remain readable in immutable history, while delivery work is authored with `cctl spec plan open <slug>` and `cctl spec plan edit <slug> --file <plan.json>`. A revision a human ended with Request Changes is terminal: its content is not carried into the new draft, and the response names those revisions in `skippedWithdrawnRevisions` so anything from them that still applies can be re-authored. Element ids, numbers and handles carry across, but element VERSIONS do not: the copied elements restart at 1 in the new revision, so re-read an element before writing it rather than reusing the version you read on the approved revision.",
    related: [
      {
        command: "spec draft",
        oneLiner: "save elements into the reopened draft",
      },
      {
        command: "spec propose",
        oneLiner: "propose the amended stage for review",
      },
      {
        command: "spec capture",
        oneLiner: "amend scope from inside a running execution instead",
      },
      {
        command: "spec create",
        oneLiner: "create a spec that does not exist yet",
      },
      {
        command: "spec import",
        oneLiner:
          "bring a spec authored outside CC in as a new one — import never amends",
      },
      {
        command: "spec request-approval",
        oneLiner:
          "route a revision_in_review revision to the human who ends the review",
      },
      {
        command: "spec withdraw-proposal",
        oneLiner:
          "end a revision_in_review revision yourself when you proposed it",
      },
    ],
  },
  {
    path: ["spec", "draft"],
    summary: "save a draft element at the version it replaces",
    description:
      "Upsert one element admitted by the current authoring stage into the editable revision. The element states the version it replaces in the file itself, as baseElementVersion: the version you last read, or null to create the element; a stale write returns the winning version, and the lone-element form returns the winning content with it. Element versions are per revision and restart at 1 — `cctl spec amend` copies the approved content into the new revision as version 1 — so re-read an element after an amendment instead of reusing a version from the revision before it. Element order is one global order per revision, sorted by position then elementId: omit position on create to append after the current last element, and omit it on update to keep the element's current slot. Nesting comes from parentElementId alone and never from position; duplicate positions are accepted and resolved by the elementId tiebreak. A --file holding a JSON array is a batch: every element in it is written in one transaction, each against its own baseElementVersion, and the response names each element by its index in the array. A write lands only in a draft, and the target revision's state picks the refusal: approved or withdrawn content returns amendment_required, so run `cctl spec amend <slug>` first; a revision already proposed returns revision_in_review, which amend refuses too until a human signs it off in Spec Studio, requests changes on it, or the conversation that proposed it takes it back with `cctl spec withdraw-proposal <slug> --revision <revision-id>`. Every element id a payload names must resolve, in this revision, to an element of the kind the field expects, or the write returns dangling_reference and nothing lands — a batch resolves ids against its own final result, so an element may reference another element the same batch introduces, in either order. An empty id array is always legal; only a populated one that does not resolve refuses. An element id this spec already owns but this revision does not carry — one introduced by a revision a human ended, or removed from the draft — is refused with historical_element_id rather than written under a fork; retry that write with \"reintroduceHistorical\": true and a null base version to bring the element back with its number and handle intact (R3 returns as R3), keeping its original kind and parent. An id owned by a DIFFERENT spec — including an ABANDONED one, which keeps its ids forever — is element_id_taken and has no such recovery: choose another id. Prefix element ids with the spec slug from the start so the collision never happens.",
    usage: [
      "cctl spec draft <slug> --file <element.json>",
      "cctl spec draft <slug> --file <elements.json>",
      "cctl spec draft <slug> --file <batch.json>",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<element.json|elements.json|batch.json>",
        description:
          'one schema-backed draft element write document, a JSON array of them for a batch, or the keyed batch {"elements": [...], "removals": [{"elementId","baseElementVersion"}]} — every element states its own baseElementVersion in each form; run `cctl spec schema <kind>` or `cctl spec schema element-batch` for the shapes, enums, and worked examples',
      },
      {
        name: "quiet",
        kind: "boolean",
        description:
          "bound the --json receipt to element identities (index, elementId, handle, elementVersion) instead of echoing every committed payload back — large batches otherwise overflow the pipe",
      },
    ],
    examples: [
      {
        invocation: "cctl spec draft audit-log --file .cc/temp/R1.json --json",
        explanation:
          'save an edited element only if the version it names is still current — {"elementId":"req-audit","kind":"requirement","parentElementId":null,"payload":{…},"baseElementVersion":3} writes over version 3 and refuses if the element moved on',
      },
      {
        invocation:
          "cctl spec draft audit-log --file .cc/temp/batch.json --json",
        explanation:
          'write many elements in one transaction from an array file — [{"elementId":"req-audit","kind":"requirement","parentElementId":null,"payload":{…},"baseElementVersion":3},{"elementId":"crit-audit-restart","kind":"criterion","parentElementId":"req-audit","payload":{…},"baseElementVersion":null}] — where each element carries its own baseElementVersion (a number to update, null to create); one refusal rolls the whole batch back and details.refusals names the offending index',
      },
    ],
    domainContext:
      "Requirements stage admits intent/context prose, requirements, and criteria; design additionally admits decisions and design narrative and is the final evergreen stage. Task elements remain readable on legacy plan revisions but are not the active planning surface. Open or edit the per-delivery graph with `cctl spec plan open <slug>` and `cctl spec plan edit <slug> --file <plan.json>`.",
    related: [
      {
        command: "spec schema",
        oneLiner: "print this file's schema, enums, and a worked example",
      },
      { command: "spec get", oneLiner: "read the current element version" },
      {
        command: "spec propose",
        oneLiner: "propose the current authoring stage",
      },
      {
        command: "spec create",
        oneLiner: "create the spec with its first element",
      },
      {
        command: "spec amend",
        oneLiner: "reopen a draft after an amendment_required refusal",
      },
      {
        command: "spec withdraw-proposal",
        oneLiner: "reopen a draft after a revision_in_review refusal",
      },
      {
        command: "spec remove",
        oneLiner: "take an element out of the same draft",
      },
    ],
  },
  {
    path: ["spec", "remove"],
    summary: "take evergreen draft elements out in one transaction",
    description:
      'Remove one or more elements from the editable evergreen revision. Each handle is resolved to its element id and its current version before anything is submitted, and every removal then travels in ONE batch — the same transaction `cctl spec draft --file` submits for {"elements": [...], "removals": [...]}. That atomicity is the point: a reference and the element it points at can only leave together, so removing them one command at a time has no legal order. Nothing is removed unless every named handle resolves in the open draft. A removal that would leave a surviving element pointing at content the revision no longer carries is refused whole, naming both ends of the dangling reference by handle; the way out is to rewrite or remove the referring element in the same act. Removal is not deletion: the element id stays the spec\'s, so re-saving it with "reintroduceHistorical": true and a null base version brings it back with its original number and handle. Removal lands only in a draft — an approved or withdrawn revision returns amendment_required and a proposed one revision_in_review, exactly as a draft write does. Delivery graph tasks are authored only through `cctl spec plan edit <slug> --file <plan.json>`.',
    usage: ["cctl spec remove <slug> <handle...>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec remove audit-log R2.3 --json",
        explanation:
          "take one criterion out of the open draft; the receipt names the reintroduction recovery",
      },
    ],
    domainContext:
      "Handles are resolved client-side, so the file contract stays the server's own removal schema — {elementId, baseElementVersion} — and a removal never depends on the server parsing handle grammar. Questions and assumptions are spec-scoped records rather than draft elements: answer or dispose of those instead of removing them.",
    related: [
      {
        command: "spec draft",
        oneLiner:
          "reintroduce a removed element, or remove alongside writes in one file",
      },
      { command: "spec show", oneLiner: "read the handles the draft carries" },
      {
        command: "spec schema",
        oneLiner: "print the batch document, removals included",
      },
    ],
  },
  {
    path: ["spec", "propose"],
    summary: "propose the current authoring stage for review",
    description:
      "Freeze the editable requirements or design revision and enter review for its current authoring stage. Delivery-plan attempts use `cctl spec plan propose <slug>` instead; legacy evergreen Plan revisions remain readable but are not the active graph-authoring surface. Blocking lint findings are returned as structured issues with an immediate instruction; do not pre-author the next stage while review is pending. The receipt carries the server's pending block — every gate the transition consults, the subjects each still needs, all unmet sign-off conditions, and the exact next command — so read that rather than inferring a gate from the revision's authoring stage.",
    usage: [
      "cctl spec propose <slug>",
      "cctl spec propose <slug> --notes <notes.md>",
    ],
    flags: [
      {
        name: "notes",
        kind: "value",
        valuePlaceholder: "<notes.md>",
        description:
          "a markdown disposition/changelog document for this review round — what changed, which prior findings it closes, and what it deliberately left alone. Persisted on the propose event itself and shown above the change list in Spec Studio, so the reviewer reads the author's account before re-deriving it from the diff. The server caps it (20000 characters) and refuses an over-cap document without proposing anything.",
      },
    ],
    examples: [
      {
        invocation: "cctl spec propose audit-log --json",
        explanation:
          "propose the current draft or receive its blocking findings",
      },
      {
        invocation:
          "cctl spec propose audit-log --notes .cc/temp/round-3.md --json",
        explanation:
          "propose with the round's disposition attached — the reviewer opens Studio to the notes, not to an unexplained diff",
      },
    ],
    domainContext:
      "A revision can consult an earlier stage's gate: applicability is measured against the nearest approved ancestor, so a requirement changed during an attempt a human withdrew still owes a requirements admission on the follow-up revision, whatever stage that revision sits at.",
    related: [
      { command: "spec draft", oneLiner: "resolve findings in the draft" },
      {
        command: "spec request-approval",
        oneLiner: "route the proposed gate to the user",
      },
      {
        command: "spec status",
        oneLiner: "read the gates and sign-off the revision still owes",
      },
      {
        command: "spec withdraw-proposal",
        oneLiner: "take back a proposal you made, before a human acts on it",
      },
    ],
  },
  {
    path: ["spec", "withdraw-proposal"],
    summary: "take back your own proposal and reopen it as a draft",
    description:
      "End a review attempt this conversation proposed, reopening its exact content as one editable draft at the same authoring stage, so an external-review fix cycle costs no human click. Only the conversation the propose event records as the author may run it — there is no takeover flag, so a successor conversation receives proposal_not_owned and a dead session is recovered by a human Request Changes. It refuses with gate_blocked once a human has engaged: any approval or unapproval on the attempt (read from the durable log, so withdrawing an approval does not undo the engagement) or any resolved or dismissed review thread. An open human comment does not block — withdraw-and-fix is the same comment → revise → re-review loop, and threads carry into the follow-up revision. It also refuses when a draft is already open, since the spec carries exactly one editable revision.",
    usage: ["cctl spec withdraw-proposal <slug> --revision <revision-id>"],
    flags: [
      {
        name: "revision",
        kind: "value",
        valuePlaceholder: "<revision-id>",
        description:
          "the proposed revision to take back — the compare-and-swap token `cctl spec propose` returned; it is never inferred, so a replacement proposal is never withdrawn by mistake",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec withdraw-proposal audit-log --revision revision-8f21 --json",
        explanation:
          "take back the proposal quoted by the propose receipt and continue in the follow-up draft it reopens",
      },
    ],
    domainContext:
      "This is the agent half of the two exits from a frozen revision. A human's Request Changes also reopens the content as a draft; a human's Withdraw ends the attempt without one, and its content is not carried forward. The revision itself stays withdrawn either way — the follow-up draft is a new revision based on it.",
    related: [
      {
        command: "spec propose",
        oneLiner: "the receipt whose revision token this command quotes",
      },
      {
        command: "spec amend",
        oneLiner: "the continuation that refuses while a proposal is open",
      },
      {
        command: "spec draft",
        oneLiner: "fix the content in the reopened draft",
      },
      {
        command: "spec request-approval",
        oneLiner: "route the review to a human instead of taking it back",
      },
      { command: "spec status", oneLiner: "read which revision is proposed" },
    ],
  },
  {
    path: ["spec", "dismiss-superseded"],
    summary: "the human act that ends a proposal an approval forked past",
    description:
      "End a proposed revision that a later APPROVED revision was created without — the stranded state ticket #50 reports, where the proposal is numbered below an approval whose lineage never carried it. The act is human-only: an agent call returns human_act_required naming the Spec Studio Review surface, because disposing of work a human was reviewing is the operator's decision. Eligibility is the same ancestry test every surface reads: a proposal whose content IS carried forward (the later approval descends from it) is not superseded and refuses with gate_blocked, as does the lineage's live proposal with nothing approved above it. On success the revision becomes withdrawn with a durable marker naming the superseding revision, the operator, and their reason, and NO draft is opened — reopening the stale content would make it the spec's only editable revision and block amending the newer approved content.",
    usage: [
      "cctl spec dismiss-superseded <slug> --revision <revision-id> --reason <text>",
    ],
    flags: [
      {
        name: "revision",
        kind: "value",
        valuePlaceholder: "<revision-id>",
        description:
          "the stranded proposed revision to dismiss, as `cctl spec status` and the Studio Review tab report it",
      },
      {
        name: "reason",
        kind: "value",
        valuePlaceholder: "<text>",
        description:
          "why the proposal is being disposed of — recorded on the durable marker, since a bare withdrawal cannot explain itself later",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec dismiss-superseded audit-log --revision revision-8f21 --reason 'revision 6 was approved from an earlier base' --json",
        explanation:
          "attempt the dismissal and read the human_act_required refusal naming the Studio surface the operator acts on",
      },
    ],
    domainContext:
      "There are three ways a proposal ends and they are not interchangeable. Request Changes (human, Studio) reopens the content as a draft. `spec withdraw-proposal` (the proposing agent, before a human engages) also reopens a draft. This act opens none: it exists only for a proposal an approved revision already forked past, where the reopened draft would be stale content blocking the approved line. The guard at propose means new lineages cannot reach this state — the act is for lineages that already did.",
    related: [
      {
        command: "spec withdraw-proposal",
        oneLiner: "the agent's own exit, which reopens a draft instead",
      },
      {
        command: "spec status",
        oneLiner: "read which revisions are proposed and which is approved",
      },
      {
        command: "spec verify",
        oneLiner: "report the stranded proposal until it is disposed of",
      },
    ],
  },
  {
    path: ["spec", "advance"],
    summary: "conclude a Notify/Off authoring stage explicitly",
    description:
      "Advance the current draft from requirements to design when the requirements dial is Notify or Off. Design is the final evergreen stage: propose it for review, then open delivery planning with `cctl spec plan open <slug>` after sign-off. Gate requires human review and sign-off instead; stale revision or stage expectations are refused without changing content.",
    usage: ["cctl spec advance <slug> --from <requirements>"],
    flags: [
      {
        name: "from",
        kind: "value",
        valuePlaceholder: "<requirements>",
        description:
          "requirements stage observed on the current draft and expected to conclude; --from design is retired because delivery planning uses cctl spec plan open",
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
        fileSource: true,
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
      "Resolve a visible question record by its qualified Q handle. The answer remains durable in spec review state. Answering is the human half of the question split — the agent opens a question FOR a human, so agent transports receive a typed human_act_required refusal; the operator answers from Spec Studio's Questions & assumptions panel, and an answer given in conversation is still recorded there by the human so the durable record shows who decided.",
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
    path: ["spec", "plan"],
    summary: "author the delivery plan attempt that becomes the executed graph",
    description:
      "A delivery plan attempt pairs one ordinary graph launch with a thin immutable spec binding. It pins one approved revision, so the spec can move on without moving the attempt, and proposal freezes the server-finalized envelope as a candidate a human approves by id and hash. Every criterion of the pinned revision carries exactly one disposition — selected, deferred, waived, delivered_elsewhere, reaffirmed, or pending_reaffirmation — so nothing leaves scope silently.",
    usage: [
      "cctl spec plan open <slug> [--seed-from last]",
      "cctl spec plan edit <slug> --file <plan.json>",
      "cctl spec plan propose <slug>",
      "cctl spec plan reopen <slug> --reason <why>",
      "cctl spec plan sign-off <slug> [--candidate <id> --candidate-hash <hash>]",
      "cctl spec plan get <slug>",
      "cctl spec plan status <slug>",
      "cctl spec plan preview <slug> --stage draft|proposed",
    ],
    flags: [],
    examples: [],
    domainContext:
      "Dispositions are selected, deferred, waived, delivered_elsewhere, reaffirmed, and pending_reaffirmation. Each selected criterion needs at least one claim by a stable authored accountability context in the graph; claims are alternatives, not task-level contributions. Judgments are made against the PINNED revision, never the evergreen head. The attempt is addressed by spec slug: a spec has at most one live attempt, so no verb takes an attempt id.",
    related: [
      {
        command: "spec plan open",
        oneLiner: "open an attempt, optionally seeded from the last delivery",
      },
      {
        command: "spec plan status",
        oneLiner: "read what the attempt still owes and who acts next",
      },
      {
        command: "spec plan preview",
        oneLiner: "read the authored or finalized launch and binding",
      },
      {
        command: "spec delta",
        oneLiner: "see the delivery classes the seed is computed from",
      },
    ],
  },
  {
    path: ["spec", "plan", "open"],
    summary: "open a delivery plan attempt against the approved revision",
    description:
      "Open the attempt this delivery is planned in. It pins the spec's current approved revision, so a later amendment never forks or blocks it. With --seed-from last, a prior direct candidate's authored launch is copied wholesale after server-owned fields are removed, and claims remain only for still-selected criteria. Every criterion of the pinned revision gets exactly one disposition.",
    usage: ["cctl spec plan open <slug> [--seed-from last]"],
    flags: [
      {
        name: "seed-from",
        kind: "value",
        valuePlaceholder: "last",
        description:
          "seed the attempt from the last delivery instead of an empty plan",
      },
    ],
    examples: [
      {
        invocation: "cctl spec plan open native-sdd --seed-from last --json",
        explanation:
          "carry the last delivery forward with a disposition on every pinned criterion",
      },
      {
        invocation: "cctl spec plan open native-sdd",
        explanation:
          "author the first plan for a spec that has never delivered",
      },
    ],
    domainContext:
      "Seeding is total-disposition-preserving and derived from the delivery delta: a criterion delivered and still fresh auto-proposes delivered_elsewhere against the execution that delivered it; a soft-stale one seeds as pending_reaffirmation, which a draft may carry and a proposal may not; undelivered, hard-stale, and previously deferred criteria become selected; a waived one stays waived. A second attempt is refused while one is still live. The seeded launch is authored data: proposal injects the pinned-spec and claims sources for the new candidate without changing its topology or dynamic controls.",
    related: [
      {
        command: "spec plan edit",
        oneLiner: "write the seeded document back with your changes",
      },
      {
        command: "spec plan status",
        oneLiner: "read what the seeded plan still owes",
      },
      {
        command: "spec delta",
        oneLiner: "read the delivery classes the seed was derived from",
      },
    ],
  },
  {
    path: ["spec", "plan", "edit"],
    summary: "write the whole plan document at the draft revision you read",
    description:
      "Replace the attempt's plan document. The file carries the draftRevision it was read at, and an edit against a revision the attempt has moved past is refused with the current one rather than silently applied — the same compare-and-swap discipline `cctl spec draft` applies per element. The receipt reports what the write did to the blocking finding count.",
    usage: ["cctl spec plan edit <slug> --file <plan.json>"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<path>",
        description:
          "JSON document: { expectedDraftRevision, document } (write it under .cc/temp/)",
      },
    ],
    examples: [
      {
        invocation: "cctl spec plan edit native-sdd --file .cc/temp/plan.json",
        explanation:
          "send the edited document back at the draft revision it was read at",
      },
    ],
    domainContext:
      "Read the current document with `cctl spec plan get <slug> --json`, edit the `plan.document` it returns, and send `{ expectedDraftRevision, document }`. The document is `{ schemaVersion: 2, launch, binding }`: launch is the exact ordinary graph launch document, while binding contains dispositions and stable authored-context claims. Run `cctl spec schema plan-edit` for the exact shape. Every edit bumps the draft revision, so a second write must re-read first.",
    related: [
      {
        command: "spec plan get",
        oneLiner: "read the document and the draft revision to send back",
      },
      {
        command: "spec plan status",
        oneLiner: "read every finding the edit did not resolve",
      },
      {
        command: "spec plan propose",
        oneLiner: "freeze the document once nothing blocks",
      },
      { command: "spec schema", oneLiner: "read the plan-edit document shape" },
    ],
  },
  {
    path: ["spec", "plan", "propose"],
    summary: "finalize and freeze an immutable candidate envelope",
    description:
      "Finalize the draft launch with server-owned sources, locks, origin, and approval policy, then admit it through the ordinary graph boundary and freeze the resulting envelope as a candidate. The transition runs the same deterministic binding checks the edit receipts and `spec plan status` report, so a refusal names every blocking finding and the act that resolves it. The frozen candidate is immutable — a reopen invalidates its approval but never rewrites it.",
    usage: ["cctl spec plan propose <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec plan propose native-sdd --json",
        explanation: "freeze the candidate and take its id and hash as data",
      },
    ],
    domainContext:
      "The candidate hash covers the finalized launch, binding, pinned revision, and attempt draft revision — so a re-propose after a reopen yields a new hash requiring a new approval even when authored content is byte-identical. Proposal injects the candidate id into its origin and claims source before hashing. A criterion left at pending_reaffirmation blocks propose until a human reaffirms it or it is selected for re-delivery.",
    related: [
      {
        command: "spec plan status",
        oneLiner: "read the findings that would refuse this",
      },
      {
        command: "spec plan sign-off",
        oneLiner: "approve the exact finalized candidate this proposal froze",
      },
      {
        command: "spec plan reopen",
        oneLiner: "take the proposal back to draft",
      },
      {
        command: "spec plan edit",
        oneLiner: "resolve a blocking finding in the document",
      },
    ],
  },
  {
    path: ["spec", "plan", "sign-off"],
    summary: "approve the stored candidate and admit the execution_start gate",
    description:
      "Sign off the finalized candidate a proposal froze. This is the ONE default approval between propose and launch: it records the approval bound to the candidate id and hash and admits the execution_start gate in the same act, so nothing else stands between an approved plan and `cctl spec start`. Under a Gate execution_start dial it is a human-only act and an agent is refused, naming the request-approval verb; under Notify or Off the same act records a policy-basis admission instead of a human approval. Omitting the identity flags reads the stored candidate first and signs off exactly what it names; a re-propose landing in between refuses rather than approving different bytes.",
    usage: [
      "cctl spec plan sign-off <slug> [--candidate <id> --candidate-hash <hash>]",
    ],
    flags: [
      {
        name: "candidate",
        kind: "value",
        valuePlaceholder: "<id>",
        description:
          "the stored candidate this approval binds — from `spec plan preview --stage proposed`",
      },
      {
        name: "candidate-hash",
        kind: "value",
        valuePlaceholder: "<hash>",
        description: "the hash of the frozen canonical candidate bytes",
      },
    ],
    examples: [
      {
        invocation: "cctl spec plan sign-off native-sdd --json",
        explanation:
          "sign off the stored candidate and take the admission basis as data",
      },
    ],
    domainContext:
      "Candidate id and candidate hash are checked together. A reopen invalidates the approval structurally, and a parked attempt tuned after sign-off refuses launch until the replacement candidate is signed off — the refusal prints both identities. Runtime defaults are resolved and audit-hashed only when start runs; sign-off always addresses the finalized candidate envelope.",
    related: [
      {
        command: "spec plan preview",
        oneLiner: "read the exact bytes this approval binds",
      },
      { command: "spec start", oneLiner: "launch the approved candidate" },
      {
        command: "spec plan reopen",
        oneLiner: "take the approval back and return to draft",
      },
      {
        command: "spec request-approval",
        oneLiner: "ask a human for the sign-off under a Gate dial",
      },
    ],
  },
  {
    path: ["spec", "plan", "reopen"],
    summary: "return an unlaunched attempt to draft, invalidating its approval",
    description:
      "Return a proposed, approved, or parked attempt to draft at a fresh draft revision. Any approval it carried no longer stands, and the re-propose that follows requires a new one. Prior snapshots stay readable exactly as proposed. A LAUNCHED attempt is refused, naming its two post-launch paths and the execution id they address.",
    usage: ["cctl spec plan reopen <slug> --reason <why>"],
    flags: [
      {
        name: "reason",
        kind: "value",
        valuePlaceholder: "<why>",
        description: "durable reason recorded beside the invalidated approval",
      },
    ],
    examples: [
      {
        invocation:
          'cctl spec plan reopen native-sdd --reason "the closeout context is missing"',
        explanation:
          "take an approved plan back to draft with the reason on the audit row",
      },
    ],
    domainContext:
      "Reopen is the exit every unlaunched plan state has. Once a plan launches, its scope is pinned: capture a discovery for the next plan, or abandon the run and open a seeded replacement.",
    related: [
      {
        command: "spec plan propose",
        oneLiner: "re-freeze once the document is fixed",
      },
      {
        command: "spec capture",
        oneLiner: "the post-launch path for discovered work",
      },
      {
        command: "spec plan status",
        oneLiner: "read the attempt's status and its exits",
      },
    ],
  },
  {
    path: ["spec", "plan", "get"],
    summary: "read the plan document the attempt carries",
    description:
      "Print the attempt's graph launch label and immutable binding. This is the document `cctl spec plan edit` takes back: read it with --json, edit `plan.document`, and send it with the draftRevision it reports.",
    usage: ["cctl spec plan get <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec plan get native-sdd --json",
        explanation:
          "take the whole plan document plus its draft revision as data before editing",
      },
    ],
    domainContext:
      "The binding dispositions and claims are bounded to ten items each in text and state their total, shown, and the read that returns the rest; --json carries the exact envelope. The launch remains graph-owned opaque data on this surface, so use the ordinary workflow renderer for graph topology and configuration.",
    related: [
      { command: "spec plan edit", oneLiner: "write the document back" },
      {
        command: "spec plan status",
        oneLiner: "read what the plan owes rather than what it says",
      },
    ],
  },
  {
    path: ["spec", "plan", "status"],
    summary: "read the attempt's state, findings, and the act it owes next",
    description:
      "Show the attempt's status, its pinned revision and draft revision, the delta basis it was seeded against, the plan lint findings that would refuse a proposal, the dispositions still awaiting a human act, every proposal snapshot, and the exact next act with the party who performs it.",
    usage: ["cctl spec plan status <slug>"],
    flags: [],
    examples: [
      {
        invocation: "cctl spec plan status native-sdd --json",
        explanation:
          "read blocking findings, unresolved dispositions, and the next act as data",
      },
    ],
    generatedReference: [NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint],
    domainContext:
      "The findings here are the SAME projection the propose refusal applies and an edit receipt counts, so a status reporting zero blocking and a propose that refuses cannot coexist. Enumerated sections are bounded to ten items each with total, shown, and the read that returns the rest in the text rendering; --json carries every row.",
    related: [
      {
        command: "spec plan edit",
        oneLiner: "resolve a finding by rewriting the document",
      },
      {
        command: "spec plan propose",
        oneLiner: "the transition the blocking findings refuse",
      },
      {
        command: "spec plan get",
        oneLiner: "read the document behind the findings",
      },
    ],
  },
  {
    path: ["spec", "plan", "preview"],
    summary: "read an authored or finalized launch envelope",
    description:
      "Show the exact authored graph launch, layout, and accountability binding from a delivery-plan attempt without launching it. `--stage draft` reads the current editable attempt and never represents approvable bytes. `--stage proposed` reads only the frozen finalized candidate, including its server-injected sources, locks, origin, and approval policy, so its candidate hash is exactly what sign-off accepts and `spec start` verifies.",
    usage: [
      "cctl spec plan preview <slug> --stage draft|proposed [--expected-draft-revision <n>]",
    ],
    flags: [
      {
        name: "stage",
        kind: "value",
        valuePlaceholder: "draft|proposed",
        description:
          "preview the delivery plan ATTEMPT instead of the revision. `draft` reads the attempt's current document and is never approvable; `proposed` reads the frozen finalized candidate and nothing else, so its candidateHash is exactly what approval binds to and start verifies",
      },
      {
        name: "expected-draft-revision",
        kind: "value",
        valuePlaceholder: "<n>",
        description:
          "compare-and-swap token for --stage draft: refuses if the attempt has moved past this draft revision, so the bytes you read are the bytes you thought you read",
      },
    ],
    examples: [
      {
        invocation: "cctl spec plan preview native-sdd --stage draft",
        explanation:
          "inspect the authored graph launch from the editable attempt before proposing it",
      },
      {
        invocation: "cctl spec plan preview native-sdd --stage proposed",
        explanation:
          "read the frozen candidate whose hash approval and launch are bound to",
      },
    ],
    related: [
      {
        command: "spec start",
        oneLiner: "launch the approved authored graph",
      },
      { command: "spec status", oneLiner: "inspect gates before launching" },
    ],
  },
  {
    path: ["spec", "request-approval"],
    summary: "route a spec gate to the user",
    description:
      "Create durable attention for a human-controlled gate. Agents can request approval but cannot approve, sign off, or change policy. Omitting --subject asks for the gate as a whole — one entry for a gate with a dozen outstanding subjects, still the same entry once they are all approved and only the revision sign-off remains, and cleared by the act that admits the gate. Naming --subject asks for that item alone, and only that item's approval clears it. The evergreen plan gate is legacy-only; approve the finalized delivery candidate with `cctl spec plan sign-off <slug>`. The ask is validated against the same gate projection `cctl spec status` reports, so it is refused rather than filed when it would open an entry no human act could clear: stale_revision (the gate is no longer evaluated against that revision), gate_not_applicable (this policy does not gate on it, the draft has not reached it, or the revision is still a draft and no human act can land on it until it is proposed), invalid_subject (nothing outstanding under that subject — the refusal lists the valid ones), and already_satisfied (the approval is already granted or admitted). Repeating an ask that is still open is safe: the receipt returns the existing attention id with alreadyRequested true, and no second Needs You entry is created.",
    usage: [
      "cctl spec request-approval <slug> --gate <gate> [--subject <handle-or-label>]",
    ],
    flags: [
      {
        name: "gate",
        kind: "value",
        valuePlaceholder: "<gate>",
        description:
          "requirements, design, execution_start, or delivery; plan is accepted only for legacy evergreen revisions — use cctl spec plan sign-off for DeliveryPlanAttempt approval",
      },
      {
        name: "subject",
        kind: "value",
        valuePlaceholder: "<handle-or-label>",
        description:
          "one review subject to route, cleared by that subject's approval alone; omit it to request the gate as a whole, which the revision sign-off clears",
      },
    ],
    examples: [
      {
        invocation:
          "cctl spec request-approval audit-log --gate requirements --subject R1",
        explanation: "route requirement R1 to the human review surface",
      },
      {
        invocation: "cctl spec request-approval audit-log --gate requirements",
        explanation:
          "open one entry for the requirements gate whatever it is waiting on — the receipt lists the outstanding subjects, and the entry survives until the revision is signed off",
      },
      {
        invocation: "cctl spec request-approval audit-log --gate delivery",
        explanation:
          "open the durable Needs You request for the run's delivery approval ahead of the merge — the gate still stops at final publish until a human grants it",
      },
    ],
    related: [
      { command: "spec status", oneLiner: "inspect pending approvals" },
      { command: "spec propose", oneLiner: "freeze the revision for review" },
      {
        command: "spec amend",
        oneLiner: "continue authoring once the review concludes",
      },
      {
        command: "spec withdraw-proposal",
        oneLiner:
          "take the proposal back instead of asking, while no human has acted",
      },
    ],
  },
  {
    path: ["spec", "start"],
    summary: "launch the approved delivery-plan candidate, exactly as approved",
    description:
      "Launch the finalized candidate the plan sign-off approved. Start verifies the approved candidateHash against the frozen canonical bytes, then creates the graph-workflow execution at the shared graph start boundary: before this command the spec owns no workflow execution and no session slot. `--inputs` supplies the ordinary graph launch inputs as a JSON object; required/default/enum/text validation is performed by that shared boundary. A spec with no approved attempt is refused, naming the exact next act in the open/propose/sign-off chain. `--park` holds a proposed or approved candidate for spec-side prelaunch review instead of launching it, still without creating any execution or taking the slot; its receipt reports the plan's projected next act, so an unapproved park points to sign-off while an approved park points to launch. Scope files are retired; open an authored delivery attempt, propose it, and obtain sign-off before starting.",
    usage: ["cctl spec start <slug> [--inputs .cc/temp/inputs.json] [--park]"],
    flags: [
      {
        name: "inputs",
        kind: "value",
        valuePlaceholder: "<inputs.json>",
        description:
          "JSON object of ordinary authored graph launch-parameter values",
      },
      {
        name: "park",
        kind: "boolean",
        description:
          "hold a proposed or approved candidate for prelaunch review — no execution is created and no session slot is taken",
      },
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<scope.json>",
        description:
          "Retired compatibility flag: scope files are refused. Open an authored delivery attempt, then propose and sign off it before starting.",
      },
    ],
    examples: [
      {
        invocation: "cctl spec start native-sdd --json",
        explanation:
          "launch the approved candidate and take its candidate hash as data",
      },
      {
        invocation:
          "cctl spec start native-sdd --inputs .cc/temp/inputs.json --json",
        explanation:
          "launch with the exact JSON object validated by the ordinary graph input contract",
      },
      {
        invocation: "cctl spec start native-sdd --park",
        explanation:
          "hold a proposed or approved candidate for prelaunch review; the receipt names sign-off or launch as the next act",
      },
    ],
    domainContext:
      "A parked attempt tuned afterwards (reopen + re-propose) changes the candidate hash, and the launch refuses until the new candidate is signed off — the refusal and the plan receipt both print the parked hash beside the current one.",
    related: [
      {
        command: "spec plan sign-off",
        oneLiner: "the one approval a launch requires",
      },
      {
        command: "spec plan preview",
        oneLiner: "read the exact bytes this launch will run",
      },
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
    summary:
      "record work discovered during a running execution as a durable discovery",
    description:
      "Record work a running execution found and deliberately did not do. Without --blocking-reason it records a durable discovery that the next `cctl spec plan open <slug>` places in a later delivery attempt, and the run keeps its pinned scope; with --blocking-reason it abandons the run through the abandon coordinator and opens a replacement attempt in the same operation, with the discovery already placed. Capture never mutates the running graph. Before launch there is no run to capture against: the command creates nothing and names the plan verb instead (`cctl spec plan edit` for a draft attempt, `cctl spec plan reopen` for a proposed, approved, or parked one). The discovered-work trace arrays may be empty at capture time, but any id they do name must resolve in the run's pinned revision to an element of the expected kind: otherwise the capture returns dangling_reference and leaves no discovery and no event behind. Capture records delivery work, never spec content: to continue authoring the evergreen spec after a gate is approved, outside any run, use `cctl spec amend`.",
    usage: [
      "cctl spec capture <slug> --file <task.json> [--execution <id>] [--blocking-reason <reason>]",
    ],
    flags: [
      {
        name: "execution",
        kind: "value",
        valuePlaceholder: "<id>",
        description:
          "the run to capture against — needed only to address a run by execution id rather than by the spec's live attempt",
      },
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<task.json>",
        description:
          "structured discovered-work document — run `cctl spec schema discovered-task` for its shape",
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
          "cctl spec capture audit-log --file .cc/temp/discovered-task.json --json",
        explanation:
          "capture a bounded discovered-work document; its trace ids may be empty at capture time",
      },
      {
        invocation:
          'cctl spec capture audit-log --file .cc/temp/discovered-task.json --blocking-reason "the pinned scope cannot absorb it" --json',
        explanation:
          "abandons the run and opens the replacement attempt in one act; the receipt names both the abandoned execution and the new attempt",
      },
    ],
    domainContext:
      "Capture is refused unless the execution is running. Non-blocking capture and blocking capture (abandon and replacement) are printed on every capture receipt. Populate coveredCriterionElementIds so the replacement attempt retains the discovery's criterion trace.",
    related: [
      {
        command: "spec plan open",
        oneLiner: "open the next delivery attempt for captured discoveries",
      },
      {
        command: "spec amend",
        oneLiner:
          "continue authoring the spec itself, not a run's delivery work",
      },
      {
        command: "spec plan edit",
        oneLiner: "the prelaunch path for a draft attempt",
      },
      {
        command: "spec plan reopen",
        oneLiner: "the prelaunch path for a proposed, approved, or parked one",
      },
      {
        command: "spec abandon",
        oneLiner: "abandon the execution without capturing work",
      },
      {
        command: "spec schema",
        oneLiner: "print the discovered-task document's schema",
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
    summary: "abandon one execution, or retire the whole spec as a human",
    description:
      "Record a required durable reason while abandoning the whole spec, or target one execution with --execution. Execution-targeted abandon aborts the linked workflow — which releases the session's execution lease — before finalizing the spec execution; a partial cleanup refusal names the exact `cctl workflow live abort` or `cctl workflow abandon` recovery and tells you to retry this command. Abandoning one execution is ordinary agent work. Retiring the whole spec is the least reversible act on this surface and is human-only: agent transports receive a typed human_act_required refusal, so ask the operator to retire the spec from Spec Studio.",
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
      {
        command: "spec start",
        oneLiner: "launch an approved delivery-plan candidate",
      },
      { command: "spec status", oneLiner: "inspect current lifecycle state" },
      {
        command: "spec capture",
        oneLiner: "capture blocking discovered work, then abandon and restart",
      },
      {
        command: "workflow live abort",
        oneLiner:
          "the exact backstop a partial abandon receipt names if the run still holds the lease",
      },
    ],
  },
];
