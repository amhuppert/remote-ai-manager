import { describe, expect, it } from "vitest";
import { dispatchGroup, type GroupVerbHandler } from "./dispatch";
import { childEntriesOf } from "./help-registry";
import { pathKey } from "./help-types";
import { EXIT_OK, EXIT_USAGE, USAGE, type CliResult } from "./shared";

const ok: CliResult = { exitCode: EXIT_OK, stdout: "ran\n", stderr: "" };

/**
 * A stub handler for every level-1 registry entry: the root's handler map is
 * subject to the same agreement check as any group's, so a partial map here
 * would throw before the behavior under test runs.
 */
function rootHandlers(
  overrides: Record<string, GroupVerbHandler> = {},
): Record<string, GroupVerbHandler> {
  const handlers: Record<string, GroupVerbHandler> = {};
  for (const entry of childEntriesOf([])) {
    handlers[pathKey(entry.path)] = async () => ok;
  }
  return { ...handlers, ...overrides };
}

/**
 * `dispatchGroup` is the registry-driven group dispatcher: it derives the valid
 * verb list from the help registry (single source of truth), routes to the
 * matching handler, and produces the "requires a subcommand" / "unknown
 * subcommand" usage failures from that same derived list — so no group module
 * hand-lists its verbs in either dispatch or its error strings.
 */
describe("dispatchGroup", () => {
  it("routes a known verb to its handler, forwarding the remaining args", async () => {
    let seen: string[] | undefined;
    const result = await dispatchGroup({
      group: ["dev"],
      rest: ["ensure", "web"],
      json: false,
      handlers: {
        list: async () => ok,
        ensure: async (rest) => {
          seen = rest;
          return ok;
        },
        stop: async () => ok,
        doctor: async () => ok,
      },
    });
    expect(result).toBe(ok);
    expect(seen).toEqual(["web"]);
  });

  it("exits 2 with the registry-derived verb list when no verb is given", async () => {
    const result = await dispatchGroup({
      group: ["dev"],
      rest: [],
      json: false,
      handlers: {
        list: async () => ok,
        ensure: async () => ok,
        stop: async () => ok,
        doctor: async () => ok,
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    // The verb list is the registry's own children (order preserved), not a
    // hand-written string in the group module.
    expect(result.stderr).toContain(
      "dev requires a subcommand: list, ensure, stop, or doctor",
    );
  });

  it("exits 2 naming the offending verb when the verb is unknown", async () => {
    const result = await dispatchGroup({
      group: ["dev"],
      rest: ["frobnicate"],
      json: false,
      handlers: {
        list: async () => ok,
        ensure: async () => ok,
        stop: async () => ok,
        doctor: async () => ok,
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('unknown dev subcommand "frobnicate"');
    // Steers back to the real children.
    expect(result.stderr).toContain(
      "dev subcommands: list, ensure, stop, or doctor",
    );
  });

  it("renders a single-verb group's subcommand list without a trailing 'or'", async () => {
    const result = await dispatchGroup({
      group: ["charter"],
      rest: [],
      json: false,
      handlers: { write: async () => ok },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("charter requires a subcommand: write");
  });

  it("dispatches a nested group verb (e.g. workflow task)", async () => {
    let seen: string[] | undefined;
    const result = await dispatchGroup({
      group: ["workflow", "task"],
      rest: ["complete", "impl-1"],
      json: false,
      handlers: {
        complete: async (rest) => {
          seen = rest;
          return ok;
        },
        add: async () => ok,
      },
    });
    expect(result).toBe(ok);
    expect(seen).toEqual(["impl-1"]);
  });

  it("throws at construction when a handler is missing a registry verb", async () => {
    // The registry is the source of truth: a handler map that omits a declared
    // child (or declares a phantom verb) is a wiring defect, caught loudly.
    await expect(
      dispatchGroup({
        group: ["dev"],
        rest: ["list"],
        json: false,
        handlers: { list: async () => ok },
      }),
    ).rejects.toThrow(/dev/);
  });

  it("emits the JSON usage envelope when json is true", async () => {
    const result = await dispatchGroup({
      group: ["dev"],
      rest: [],
      json: true,
      handlers: {
        list: async () => ok,
        ensure: async () => ok,
        stop: async () => ok,
        doctor: async () => ok,
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("dev requires a subcommand");
  });
});

/**
 * The empty group path is the CLI root: its verbs are the registry's level-1
 * entries, so the root gets the same handler/registry agreement guarantee every
 * nested group has. Its two usage failures keep the front-door wording — an
 * empty argv prints the whole usage index, and an unrecognized first token is a
 * command rather than a subcommand.
 */
describe("dispatchGroup at the root", () => {
  it("routes a level-1 command to its handler, forwarding the remaining args", async () => {
    let seen: string[] | undefined;
    const result = await dispatchGroup({
      group: [],
      rest: ["ticket", "get", "12"],
      json: false,
      handlers: rootHandlers({
        ticket: async (rest) => {
          seen = rest;
          return ok;
        },
      }),
    });
    expect(result).toBe(ok);
    expect(seen).toEqual(["get", "12"]);
  });

  it("prints the top-level usage index when no command is given", async () => {
    const result = await dispatchGroup({
      group: [],
      rest: [],
      json: false,
      handlers: rootHandlers(),
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toBe(USAGE);
    expect(result.stdout).toBe("");
  });

  it("emits the missing-command envelope when json is true", async () => {
    const result = await dispatchGroup({
      group: [],
      rest: [],
      json: true,
      handlers: rootHandlers(),
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: "missing command",
    });
  });

  it("names an unrecognized first token as a command, not a subcommand", async () => {
    const result = await dispatchGroup({
      group: [],
      rest: ["frobnicate"],
      json: false,
      handlers: rootHandlers(),
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('unknown command "frobnicate"');
    expect(result.stderr).not.toContain("subcommand");
    // The scoped one-liner, never the full usage dump (its marker is `commands:`).
    expect(result.stderr).not.toContain("commands:");
  });

  it("throws when a level-1 registry entry has no root handler", async () => {
    const handlers = rootHandlers();
    delete handlers["ticket"];
    await expect(
      dispatchGroup({ group: [], rest: ["version"], json: false, handlers }),
    ).rejects.toThrow(/ticket/);
  });
});
