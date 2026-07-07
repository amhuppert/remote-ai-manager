import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl fixture` (docs/design/cc-cli/04 §2.2/§2.4): the
 * `fixture` and `fixture session` group hubs plus the session create/delete,
 * prompt, and status leaves. Ported from the legacy `help.ts` block and the
 * cc-cli SKILL.md; flags match `fixture.ts`'s `checkFlags` per verb.
 */

/**
 * The load-bearing safety fact for every fixture verb: it runs against the
 * session's WORKTREE dev server, never the managing CC instance. Preserved as
 * shared `domainContext` on the leaves — each node is disclosed independently, so
 * the warning must ride with each one, not only the hub.
 */
const TARGET_NOTE =
  "Targets the session's WORKTREE dev server (auto-resolved via `cctl dev`), never the managing CC instance — fixtures create and delete real sessions. An explicit --target equal to the managing server is refused. `--dev <serverName>` disambiguates when several dev servers run.";

const CC_LIVE_FEATURE_TEST = {
  name: "cc-live-feature-test",
  loadWhen: "before scaffolding a live feature test with fixtures",
  path: ".claude/skills/cc-live-feature-test/SKILL.md",
} as const;

export const fixtureHelpEntries: CommandHelpEntry[] = [
  {
    path: ["fixture"],
    dynamicContext: true,
    summary: "scaffold test sessions and run prompts against a dev server",
    description:
      "Scaffold live-test state — throwaway sessions and real LLM turns — for verifying features in the running app. Every verb targets the session's worktree dev server (via `cctl dev`'s registry), never the managing CC instance.",
    usage: ["cctl fixture <session create|session delete|prompt|status>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "dev ensure",
        oneLiner: "start the worktree dev server fixtures run against",
      },
    ],
    skills: [CC_LIVE_FEATURE_TEST],
  },
  {
    path: ["fixture", "session"],
    dynamicContext: true,
    summary: "create and delete throwaway test sessions",
    description:
      "Create or tear down a throwaway session on the worktree dev server for live testing.",
    usage: ["cctl fixture session <create|delete>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "fixture prompt",
        oneLiner: "run a real LLM turn in the session",
      },
      {
        command: "fixture status",
        oneLiner: "list the session's conversations",
      },
    ],
  },
  {
    path: ["fixture", "session", "create"],
    dynamicContext: true,
    summary: "create a throwaway test session and pre-warm its routes",
    description:
      "Create the session and return everything a live test needs in one envelope: sessionName, a ready conversationId, deep-link urls (session page + /conversations?c=<id>), and the dev instance's dbPath/transcriptPath for backend verification. It pre-warms the returned routes so the first browser navigation lands warm; --skip-warm opts out.",
    usage: [
      "cctl fixture session create <project> [--name <n>] [--dev <serverName>] [--target <url>] [--skip-warm]",
    ],
    flags: [
      {
        name: "name",
        kind: "value",
        valuePlaceholder: "<n>",
        description:
          "session name (a unique `fx-…` name is generated when omitted)",
      },
      {
        name: "dev",
        kind: "value",
        valuePlaceholder: "<serverName>",
        description: "pick the dev server when several are running",
      },
      {
        name: "target",
        kind: "value",
        valuePlaceholder: "<url>",
        description: "explicit dev-server base URL (managing server refused)",
      },
      {
        name: "skip-warm",
        kind: "boolean",
        description: "skip pre-warming the returned routes",
      },
    ],
    examples: [
      {
        invocation: "cctl fixture session create scratch-project --json",
        explanation:
          "<project> is a project ON the dev server (use a scratch one); an unknown name exits 2 listing the dev server's projects",
      },
    ],
    domainContext: TARGET_NOTE,
    related: [
      {
        command: "fixture prompt",
        oneLiner: "run a real LLM turn in the new session",
      },
      {
        command: "fixture session delete",
        oneLiner: "tear the session down when the test finishes",
      },
    ],
    skills: [CC_LIVE_FEATURE_TEST],
  },
  {
    path: ["fixture", "session", "delete"],
    dynamicContext: true,
    summary: "tear down a throwaway test session",
    description:
      "Tear the session down (encodes the DELETE …/sessions?sessionName= query-param contract so you never have to). Terminal: no hint.",
    usage: ["cctl fixture session delete <project> <sessionName>"],
    flags: [
      {
        name: "dev",
        kind: "value",
        valuePlaceholder: "<serverName>",
        description: "pick the dev server when several are running",
      },
      {
        name: "target",
        kind: "value",
        valuePlaceholder: "<url>",
        description: "explicit dev-server base URL (managing server refused)",
      },
    ],
    examples: [
      {
        invocation: "cctl fixture session delete scratch-project fx-abc123",
        explanation:
          "<sessionName> is the `fx-…` name from `fixture session create` output",
      },
    ],
    domainContext: TARGET_NOTE,
    related: [
      {
        command: "fixture session create",
        oneLiner: "create a fresh throwaway session",
      },
      {
        command: "fixture status",
        oneLiner: "check the session before deleting",
      },
    ],
  },
  {
    path: ["fixture", "prompt"],
    dynamicContext: true,
    summary: "run a real LLM turn in a test session",
    description:
      "Run a real LLM turn in the session (defaults to its only conversation; pass --conversation when there are several). With --wait it blocks by reading the prompt SSE stream to the server's done/error event — no hand-rolled polling; --timeout <sec> caps the wait (the turn keeps running server-side on timeout). Without --wait it returns immediately with turn: started.",
    usage: [
      'cctl fixture prompt <project> <sessionName> --text "<prompt>" [--conversation <id>] [--wait [--timeout <sec>]]',
    ],
    flags: [
      {
        name: "text",
        kind: "value",
        valuePlaceholder: '"<prompt>"',
        description: "required — the prompt to run",
      },
      {
        name: "conversation",
        kind: "value",
        valuePlaceholder: "<id>",
        description:
          "target conversation on the dev server (required when the session has several); NOT the global --conversation — CC_CONVERSATION_ID is never used here",
      },
      {
        name: "dev",
        kind: "value",
        valuePlaceholder: "<serverName>",
        description: "pick the dev server when several are running",
      },
      {
        name: "target",
        kind: "value",
        valuePlaceholder: "<url>",
        description: "explicit dev-server base URL (managing server refused)",
      },
      {
        name: "wait",
        kind: "boolean",
        description: "block on the prompt SSE stream until done/error",
      },
      {
        name: "timeout",
        kind: "value",
        valuePlaceholder: "<sec>",
        description:
          "cap the --wait in seconds (the turn keeps running on timeout)",
      },
    ],
    examples: [
      {
        invocation:
          'cctl fixture prompt scratch-project fx-abc123 --text "reply with exactly: marker-7" --wait',
        explanation:
          "--wait blocks until the turn finishes; then verify against durable state (grep the transcriptPath), not the UI",
      },
    ],
    domainContext: TARGET_NOTE,
    related: [
      {
        command: "fixture status",
        oneLiner: "check conversation status after a non-waited prompt",
      },
      {
        command: "fixture session create",
        oneLiner: "create the session to prompt into",
      },
    ],
    skills: [CC_LIVE_FEATURE_TEST],
  },
  {
    path: ["fixture", "status"],
    dynamicContext: true,
    summary: "list a test session's conversations and their status",
    description:
      "One-shot list of the session's conversations with their status (new | awaiting | running | waiting_for_input; a finished turn settles at awaiting).",
    usage: ["cctl fixture status <project> <sessionName>"],
    flags: [
      {
        name: "dev",
        kind: "value",
        valuePlaceholder: "<serverName>",
        description: "pick the dev server when several are running",
      },
      {
        name: "target",
        kind: "value",
        valuePlaceholder: "<url>",
        description: "explicit dev-server base URL (managing server refused)",
      },
    ],
    examples: [
      {
        invocation: "cctl fixture status scratch-project fx-abc123",
        explanation:
          "a finished turn settles at `awaiting` — poll here after a `fixture prompt` without --wait",
      },
    ],
    domainContext: TARGET_NOTE,
    related: [
      {
        command: "fixture prompt",
        oneLiner: "run another turn in the session",
      },
      {
        command: "fixture session delete",
        oneLiner: "tear the session down when done",
      },
    ],
  },
];
