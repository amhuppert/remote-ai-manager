import { describe, expect, it } from "vitest";

import { checkpointLifecycleRefusalCodeSchema } from "@/lib/conversation-checkpoints/admission";

import { runCli } from "../../core";
import { allHelpEntries, isGroup } from "../../help-registry";
import { pathKey, type CommandHelpEntry } from "../../help-types";
import type { CliEnv, CliHost } from "../../shared";

/**
 * Offline help for the checkpoint and evidence leaves (R8.8).
 *
 * The property under test is that `--help` is a PURE function of the registry.
 * An agent reaches for help precisely when something is wrong — no server, no
 * token, a refused request — so help that needed either would be missing when
 * it is needed. The optional-context block below is the sharp end of that: a
 * live context fetch that throws or answers 500 must leave the static help byte
 * for byte identical and its exit code untouched.
 *
 * The leaf list is derived from the registry rather than typed here, so a new
 * checkpoint or evidence verb is covered the moment it is registered.
 */

const nodesUnder = (heads: readonly string[]): CommandHelpEntry[] =>
  allHelpEntries().filter(
    (entry) =>
      entry.path[0] === "conversation" &&
      heads.includes(entry.path[1] ?? "") &&
      // `compact` is the reading artifact, a different command family.
      entry.path[1] !== "compact",
  );

const FAMILY = ["compact-context", "checkpoint", "entry", "image"] as const;
const NODES = nodesUnder(FAMILY);
const LEAVES = NODES.filter((entry) => !isGroup(entry));

interface CountingHost extends CliHost {
  fetches: number;
}

/** A host with no network at all: reaching for one is the failure. */
function offlineHost(): CountingHost {
  const host: CountingHost = {
    fetches: 0,
    async fetch() {
      host.fetches += 1;
      throw new Error("help must not reach the network");
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  return host;
}

/** A host that HAS a server and answers the optional help-context call badly. */
function contextFailingHost(mode: "throws" | "server_error"): CountingHost {
  const host: CountingHost = {
    fetches: 0,
    async fetch() {
      host.fetches += 1;
      if (mode === "throws") throw new Error("ECONNREFUSED");
      return new Response("upstream exploded", { status: 500 });
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  return host;
}

const CONNECTED_ENV: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "self-conv",
};

function helpJson(stdout: string): {
  ok: boolean;
  help: {
    command: string;
    summary: string;
    description: string;
    usage: string[];
    flags: { name: string }[];
    examples: { invocation: string; explanation: string }[];
    related: { command: string }[];
    domainContext?: string;
  };
} {
  return JSON.parse(stdout) as ReturnType<typeof helpJson>;
}

describe("checkpoint and evidence help is offline and unauthenticated", () => {
  it("covers the whole registered command family", () => {
    expect(NODES.map((entry) => pathKey(entry.path)).sort()).toEqual([
      "conversation checkpoint",
      "conversation checkpoint cancel",
      "conversation checkpoint check",
      "conversation checkpoint get",
      "conversation checkpoint list",
      "conversation checkpoint reconcile",
      "conversation compact-context",
      "conversation entry",
      "conversation entry get",
      "conversation image",
      "conversation image get",
    ]);
  });

  for (const entry of NODES) {
    const key = pathKey(entry.path);

    it(`"${key} --help" renders text with no server, token or network`, async () => {
      const host = offlineHost();
      const result = await runCli([...entry.path, "--help"], {}, host);

      expect(result.exitCode).toBe(0);
      expect(host.fetches).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(key);
      expect(result.stdout).toContain(entry.summary);
      // A group's TEXT help is an index of its verbs, not a usage shape.
      if (!isGroup(entry)) {
        for (const shape of entry.usage) expect(result.stdout).toContain(shape);
      }
      for (const flag of entry.flags) {
        expect(result.stdout).toContain(`--${flag.name}`);
      }
      for (const example of entry.examples) {
        expect(result.stdout).toContain(example.invocation);
      }
      for (const ref of entry.related)
        expect(result.stdout).toContain(ref.command);
    });

    it(`"${key} --help --json" describes the same command structurally`, async () => {
      const host = offlineHost();
      const result = await runCli(
        [...entry.path, "--help", "--json"],
        {},
        host,
      );

      expect(result.exitCode).toBe(0);
      expect(host.fetches).toBe(0);
      const body = helpJson(result.stdout);
      expect(body.ok).toBe(true);
      expect(body.help.command).toBe(key);
      expect(body.help.description).toBe(entry.description);
      expect(body.help.usage).toEqual(entry.usage);
      expect(body.help.flags.map((flag) => flag.name)).toEqual(
        expect.arrayContaining(entry.flags.map((flag) => flag.name)),
      );
      expect(body.help.examples).toEqual(entry.examples);
      expect(body.help.related.map((ref) => ref.command)).toEqual(
        entry.related.map((ref) => ref.command),
      );
    });
  }
});

describe("a failing optional context leaves static help untouched", () => {
  for (const entry of LEAVES) {
    const key = pathKey(entry.path);

    it(`"${key} --help" is byte-identical when the context fetch fails`, async () => {
      const offline = await runCli(
        [...entry.path, "--help"],
        {},
        offlineHost(),
      );

      for (const mode of ["throws", "server_error"] as const) {
        const host = contextFailingHost(mode);
        const result = await runCli(
          [...entry.path, "--help"],
          CONNECTED_ENV,
          host,
        );
        // The fetch must actually have been attempted, or this proves nothing.
        expect(
          host.fetches,
          `${key} (${mode}) never tried the context`,
        ).toBeGreaterThan(0);
        expect(result.exitCode, `${key} (${mode}) must still exit 0`).toBe(0);
        expect(result.stdout, `${key} (${mode}) changed its static help`).toBe(
          offline.stdout,
        );
        expect(result.stderr).toBe("");
      }
    });

    it(`"${key} --help --json" is byte-identical when the context fetch fails`, async () => {
      const offline = await runCli(
        [...entry.path, "--help", "--json"],
        {},
        offlineHost(),
      );
      const host = contextFailingHost("throws");
      const result = await runCli(
        [...entry.path, "--help", "--json"],
        CONNECTED_ENV,
        host,
      );

      expect(host.fetches).toBeGreaterThan(0);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(offline.stdout);
      // No `context` key appears when the optional fetch produced nothing.
      expect(JSON.parse(result.stdout)).not.toHaveProperty("help.context");
    });
  }
});

describe("the help teaches the distinctions acting on the wrong one breaks", () => {
  async function textOf(key: string): Promise<string> {
    const result = await runCli(
      [...key.split(" "), "--help"],
      {},
      offlineHost(),
    );
    expect(result.exitCode).toBe(0);
    return result.stdout;
  }

  it("names every blocker code the preflight can report, offline", async () => {
    const text = await textOf("conversation checkpoint check");
    for (const code of checkpointLifecycleRefusalCodeSchema.options) {
      expect(
        text,
        `checkpoint check help omits blocker code "${code}"`,
      ).toContain(code);
    }
    // The two transitions a finding is labelled by.
    expect(text).toContain("blocks_compact_context");
    expect(text).toContain("blocks_recovery");
  });

  it("separates raw sequence coordinates from message indexes", async () => {
    const text = await textOf("conversation entry get");
    expect(text).toMatch(/raw JSONL line coordinate/i);
    expect(text).toMatch(/#N message index/i);
    expect(text).toMatch(/--seq-range/);
    expect(text).toMatch(/--message-range/);
  });

  it("names the image-bearing content block index as the second coordinate", async () => {
    const text = await textOf("conversation image get");
    expect(text).toMatch(/image-bearing content block index/i);
    expect(text).toMatch(/paired marker\/reference is one image/i);
    // The example spells both coordinates out rather than one bare number.
    expect(text).toContain("cctl conversation image get 0197a3c2-... 148 2");
  });

  it("separates READY from APPLIED", async () => {
    const text = await textOf("conversation compact-context");
    expect(text).toMatch(/READY/);
    expect(text).toMatch(/next ordinary user message delivers it once/i);
    expect(await textOf("conversation checkpoint get")).toMatch(
      /`applied` means an ordinary turn accepted the seed/i,
    );
  });

  it("requires an explicit operation id for recovery", async () => {
    const text = await textOf("conversation compact-context");
    expect(text).toContain("--recover <operation-id>");
    expect(await textOf("conversation checkpoint reconcile")).toMatch(
      /compact-context --recover <operation-id>/,
    );
  });

  it("states that a mutation never re-scopes itself", async () => {
    for (const key of [
      "conversation compact-context",
      "conversation checkpoint cancel",
      "conversation checkpoint reconcile",
    ]) {
      const text = await textOf(key);
      expect(text, `${key} omits the mutation scope rule`).toMatch(
        /never discovers another owning scope/i,
      );
      expect(text).toMatch(/--project/);
    }
  });

  it("distinguishes compact-context from the reading artifact", async () => {
    const text = await textOf("conversation compact-context");
    expect(text).toMatch(/distinct from `conversation compact`/i);
    expect(text).toContain("conversation compact");
  });

  it("does not promise that building a checkpoint is free of model work", async () => {
    // Generation runs the working-state pass and may repair it, so the useful
    // distinction is between compaction work and the CONVERSATION's own turns —
    // an agent told "no model request" would mis-price the action and would
    // also expect no compaction usage on the receipt it then reads.
    const text = await textOf("conversation compact-context");
    expect(text).not.toMatch(/sends no model request/i);
    expect(text).toMatch(/model work/i);
    expect(text).toMatch(/no ordinary turn|adds no turn/i);
    expect(text).toMatch(/consumes no queued message/i);
  });

  it("routes escalation from the bounded read to the complete evidence", async () => {
    // The read names a coordinate; the export returns it whole; the image
    // handle inside that export returns the original bytes.
    expect(await textOf("conversation entry get")).toContain(
      "conversation image get",
    );
    expect(await textOf("conversation entry get")).toContain(
      "conversation read",
    );
    expect(await textOf("conversation image get")).toContain(
      "conversation entry get",
    );
  });
});
