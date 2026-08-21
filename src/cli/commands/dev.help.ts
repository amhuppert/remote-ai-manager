import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl dev` (docs/design/cc-cli/04 §2.2): the group
 * hub plus the list/ensure/stop leaves.
 */
export const devHelpEntries: CommandHelpEntry[] = [
  {
    path: ["dev"],
    dynamicContext: true,
    summary: "list, ensure, stop, and diagnose dev servers",
    description:
      "Manage this session's dev servers — the app processes CC spawns per worktree (ports, local/remote URLs, liveness). A CC dev server is a second CC instance with its own database, logs, transcripts, and api-token; `dev doctor` reports both instances side by side.",
    usage: ["cctl dev <list|ensure|stop|doctor>"],
    flags: [],
    examples: [],
    related: [],
    skills: [
      {
        name: "command-center:dev-server-setup",
        loadWhen: "to add or change a devServers entry in CommandCenter.json",
        path: "plugins/command-center/command-center/skills/dev-server-setup/SKILL.md",
      },
    ],
  },
  {
    path: ["dev", "list"],
    dynamicContext: true,
    summary: "show configured dev servers with status and URLs",
    description:
      "Show every configured server with its status and the local/remote URLs, plus its failure reason and log-file path when it has them. With --json each entry carries a derived `localUrl`.",
    usage: ["cctl dev list [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl dev list",
        explanation:
          "re-check liveness after `cctl dev ensure` — a server may still be starting",
      },
    ],
    related: [
      {
        command: "dev ensure",
        oneLiner: "start a server and block until it is live",
      },
      { command: "dev stop", oneLiner: "stop a running server" },
    ],
  },
  {
    path: ["dev", "ensure"],
    dynamicContext: true,
    summary: "start a dev server and block until it is live",
    description:
      "Start (or adopt) a server and block until it reaches running (or a bounded timeout), then print its resolved local/remote URLs. Omit <serverName> when the project configures exactly one server; an ambiguous omission exits 2 listing the names.",
    usage: ["cctl dev ensure [<serverName>]"],
    flags: [],
    examples: [
      {
        invocation: "cctl dev ensure",
        explanation:
          "blocks until liveness, then prints the localUrl to drive — never assume port 3000/6006; parallel sessions run on different ports",
      },
    ],
    related: [
      {
        command: "dev list",
        oneLiner: "re-check liveness without starting anything",
      },
      { command: "dev stop", oneLiner: "stop the server when done" },
    ],
    skills: [
      {
        name: "playwright-cli",
        loadWhen: "before driving a browser to verify UI against the localUrl",
        path: ".claude/skills/playwright-cli/SKILL.md",
      },
    ],
  },
  {
    path: ["dev", "stop"],
    dynamicContext: true,
    summary: "stop a running dev server",
    description:
      "Stop a named server (ownership-verified, so externally owned listeners are never killed). Terminal: no hint.",
    usage: ["cctl dev stop <serverName>"],
    flags: [],
    examples: [
      {
        invocation: "cctl dev stop web",
        explanation:
          "stops the server named `web` (names come from `cctl dev list`)",
      },
    ],
    related: [
      { command: "dev list", oneLiner: "list server names and statuses" },
      {
        command: "dev ensure",
        oneLiner: "restart a server and wait for liveness",
      },
    ],
  },
  {
    path: ["dev", "doctor"],
    dynamicContext: true,
    summary: "show which CC instance you are driving (managing vs dev server)",
    description:
      "Report the managing CC server and this session's dev server side by side — build stamp, the state directory each owns, the cctl each publishes — and name which one a bare `cctl` verb reaches. Run it when something you created through the CLI does not appear in the dev server's UI: a dev server is a separate CC instance, so server-owned state (validation runs, workflow executions, jobs, notifications, conversations) created on one is invisible in the other. It resolves the dev server and authenticates with THAT server's token, which is why `cctl doctor --server <devUrl>` 401s by hand — the ambient CC_API_TOKEN belongs to the managing instance.",
    usage: ["cctl dev doctor [<serverName>]"],
    flags: [],
    examples: [
      {
        invocation: "cctl dev doctor",
        explanation:
          "differing `config dir` values mean two instances and two databases — produce state INSIDE the dev server (`cctl fixture`) rather than through a bare verb",
      },
    ],
    domainContext:
      "Reads the dev-server registry without stating a build, so it still answers when this binary is skewed against either instance — diagnosing that skew is one of its jobs.",
    related: [
      {
        command: "doctor",
        oneLiner: "diagnose one server you name, with your own token",
      },
      {
        command: "fixture session create",
        oneLiner: "produce state inside the dev instance instead of this one",
      },
      { command: "dev list", oneLiner: "server names, ports, and log paths" },
    ],
    skills: [
      {
        name: "cc-live-feature-test",
        loadWhen:
          "when a live test's state is not showing up in the dev server's UI",
        path: ".claude/skills/cc-live-feature-test/SKILL.md",
      },
    ],
  },
];
