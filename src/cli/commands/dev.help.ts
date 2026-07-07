import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl dev` (docs/design/cc-cli/04 §2.2): the group
 * hub plus the list/ensure/stop leaves. Ported from the legacy `help.ts` block
 * and the cc-cli SKILL.md; `dev.ts` reads no command-specific flags.
 */
export const devHelpEntries: CommandHelpEntry[] = [
  {
    path: ["dev"],
    dynamicContext: true,
    summary: "list, ensure, and stop dev servers",
    description:
      "Manage this session's dev servers — the app processes CC spawns per worktree (ports, local/remote URLs, liveness).",
    usage: ["cctl dev <list|ensure|stop>"],
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
      "Show every configured server with its status and the local/remote URLs. With --json each entry carries a derived `localUrl`.",
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
];
