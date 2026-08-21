import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl version` and `cctl doctor` (docs/design/cc-cli/04
 * §2.2). `version` has no command module of its own — it is dispatch-adjacent and
 * lives in `core.ts` — so this file is where the pair's help stays together.
 */
export const metaHelpEntries: CommandHelpEntry[] = [
  {
    path: ["doctor"],
    summary: "check connectivity, auth, and build parity with the CC server",
    description:
      "The connectivity/auth/build diagnostic for ONE server — the ambient CC_SERVER_URL, or whichever `--server` names. Run it first whenever any cctl command exits 3. Success prints the server URL, the server and cli build stamps, the state directory that server owns, the cctl it publishes (the recovery binary for an exit-4 skew), your resolved identity, and token validity.",
    usage: ["cctl doctor [--server <url>]"],
    flags: [],
    examples: [
      {
        invocation: "cctl doctor",
        explanation:
          "run after any exit-3 failure to tell a down server from a rejected token",
      },
      {
        invocation: "cctl doctor --server <url>",
        explanation:
          "prints that server's `cliPath` — the binary to re-run after an exit-4 build skew. Every instance mints its own token, so a URL other than yours needs that instance's; `cctl dev doctor` does that resolution for a dev server",
      },
    ],
    related: [
      {
        command: "dev doctor",
        oneLiner:
          "diagnose the managing/dev-server pair, each with its own token",
      },
      { command: "version", oneLiner: "print just the cctl build stamp" },
      {
        command: "exit-codes",
        oneLiner: "what the code the failing command exited with asserts",
      },
      {
        command: "logs",
        oneLiner:
          "analyze the local server logs once connectivity checks out clean",
      },
    ],
  },
  {
    path: ["version"],
    summary: "print the cctl build stamp",
    description: "Print the cctl build stamp (git sha + build time).",
    usage: ["cctl version"],
    flags: [],
    examples: [
      {
        invocation: "cctl version",
        explanation: "compare against the server build shown by `cctl doctor`",
      },
    ],
    related: [
      {
        command: "doctor",
        oneLiner: "full connectivity/auth/build-parity check",
      },
      {
        command: "exit-codes",
        oneLiner: "what each cctl exit code means and how to recover",
      },
    ],
  },
];
