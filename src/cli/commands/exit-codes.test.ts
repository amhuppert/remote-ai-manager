import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import { EXIT_OK, EXIT_TAXONOMY } from "../exit-taxonomy";
import type { CliEnv, CliHost } from "../shared";

const env: CliEnv = {};

/** Any request would be a defect: the recovery path must work offline. */
const offlineHost: CliHost = {
  async fetch() {
    throw new Error("cctl exit-codes must not contact the server");
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

describe("cctl exit-codes", () => {
  it("prints every taxonomy row with its meaning and recovery command", async () => {
    const result = await runCli(["exit-codes"], env, offlineHost);

    expect(result.exitCode).toBe(EXIT_OK);
    for (const row of EXIT_TAXONOMY) {
      expect(result.stdout).toContain(row.meaning);
      if (row.recovery !== null) expect(result.stdout).toContain(row.recovery);
    }
  });

  it("carries the taxonomy as data in the --json envelope", async () => {
    const result = await runCli(["exit-codes", "--json"], env, offlineHost);

    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      exitCodes: EXIT_TAXONOMY,
    });
  });

  it("teaches the same table through `cctl help exit-codes`", async () => {
    // Help is the recovery path an agent reaches for after a non-zero exit, so
    // the node's body derives from the taxonomy rather than restating it.
    const help = await runCli(["help", "exit-codes"], env, offlineHost);

    expect(help.exitCode).toBe(EXIT_OK);
    for (const row of EXIT_TAXONOMY) {
      expect(help.stdout).toContain(row.meaning);
    }
  });

  it("refuses an undeclared flag before doing anything", async () => {
    const result = await runCli(
      ["exit-codes", "--nope", "x"],
      env,
      offlineHost,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--nope");
  });
});
