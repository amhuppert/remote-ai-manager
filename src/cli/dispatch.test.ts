import { describe, expect, it } from "vitest";
import { dispatchGroup } from "./dispatch";
import { EXIT_OK, EXIT_USAGE, type CliResult } from "./shared";

const ok: CliResult = { exitCode: EXIT_OK, stdout: "ran\n", stderr: "" };

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
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    // The verb list is the registry's own children (order preserved), not a
    // hand-written string in the group module.
    expect(result.stderr).toContain(
      "dev requires a subcommand: list, ensure, or stop",
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
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('unknown dev subcommand "frobnicate"');
    // Steers back to the real children.
    expect(result.stderr).toContain("dev subcommands: list, ensure, or stop");
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
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("dev requires a subcommand");
  });
});
