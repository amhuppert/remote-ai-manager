import { describe, expect, it } from "vitest";
import { runCli } from "./core";
import { allHelpEntries, isGroup } from "./help-registry";
import { pathKey } from "./help-types";
import type { CliEnv, CliHost } from "./shared";

/**
 * `--json` is the mode that feeds code (docs/design/cc-cli/09 §10): whatever a
 * command decides, stdout has to be one parseable object carrying `ok`. The
 * registry drives the sweep, so a NEW leaf is covered the moment its entry
 * lands — the failure mode this closes is a command that renders text on a path
 * `--json` was never exercised on, which a per-command test only finds if
 * someone remembers to write it.
 */

/** A session agent's environment: identity resolves, so commands reach a request. */
const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_SCOPE: "session",
  CC_SESSION: "sess",
  CC_CONVERSATION_ID: "conv-1",
};

/**
 * Answers every request 200 with a body no command's schema recognizes, and
 * accepts writes into memory. The point is coverage of the ENVELOPE, not of any
 * command's happy path: whichever arm a leaf takes — usage refusal, unreadable
 * response, or success — it must serialize the same way.
 */
function stubHost(): CliHost {
  return {
    async fetch() {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile() {},
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const LEAVES = allHelpEntries().filter((entry) => !isGroup(entry));

describe("universal --json envelope", () => {
  it("sweeps every leaf in the registry", () => {
    expect(LEAVES.length).toBeGreaterThan(50);
  });

  for (const leaf of LEAVES) {
    const key = pathKey(leaf.path);
    it(`"${key} --json" writes one JSON object with a boolean ok`, async () => {
      const result = await runCli([...leaf.path, "--json"], env, stubHost());

      expect(
        result.stdout.trimEnd(),
        `${key} --json wrote nothing to stdout — a --json caller has no result to read`,
      ).not.toBe("");

      const lines = result.stdout.trimEnd().split("\n");
      expect(
        lines.length,
        `${key} --json wrote ${lines.length} stdout lines — a caller parsing stdout gets a syntax error`,
      ).toBe(1);

      const parsed: unknown = JSON.parse(lines[0] ?? "");
      expect(
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
        `${key} --json did not write a JSON object`,
      ).toBe(true);
      expect(
        (parsed as { ok?: unknown }).ok,
        `${key} --json envelope must carry a boolean ok`,
      ).toBeTypeOf("boolean");
    });
  }
});
