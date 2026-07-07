import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl doctor` and `cctl version` (docs/design/cc-cli/04
 * §2.2) — they have no command module of their own (both live in `core.ts`), so
 * their help lives here. Ported from the legacy `help.ts` block and SKILL.md.
 */
export const metaHelpEntries: CommandHelpEntry[] = [
  {
    path: ["doctor"],
    summary: "check connectivity, auth, and build parity with the CC server",
    description:
      "The connectivity/auth/build diagnostic. Run it first whenever any cctl command exits 3. Success prints the server URL, the server and cli build stamps, your resolved identity, and token validity.",
    usage: ["cctl doctor"],
    flags: [],
    examples: [
      {
        invocation: "cctl doctor",
        explanation:
          "run after any exit-3 failure to tell a down server from a rejected token",
      },
    ],
    related: [
      { command: "version", oneLiner: "print just the cctl build stamp" },
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
    ],
  },
];
