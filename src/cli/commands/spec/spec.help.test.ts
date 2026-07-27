import { describe, expect, it } from "vitest";

import { runCli } from "../../core";
import type { CliEnv, CliHost } from "../../shared";

const env: CliEnv = {};

function helpHost(): CliHost {
  return {
    async fetch() {
      throw new Error("help must never depend on the server");
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
}

async function helpText(path: string[]): Promise<string> {
  const result = await runCli([...path, "--help"], env, helpHost());
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("cctl spec help nodes", () => {
  /**
   * The ordering contract was previously guessed by an authoring agent, and the
   * guess (per-parent order, position implying nesting) was wrong. Every
   * surface that describes the write document has to state the contract the
   * repository actually enforces.
   */
  it("states the element ordering contract wherever the write document is described", async () => {
    for (const path of [
      ["spec", "draft"],
      ["spec", "schema"],
    ]) {
      const text = (await helpText(path)).toLowerCase();
      expect(text, `${path.join(" ")}: no global-order statement`).toContain(
        "one global order per revision",
      );
      expect(text, `${path.join(" ")}: no tiebreak statement`).toContain(
        "elementid",
      );
      expect(text, `${path.join(" ")}: no append-on-omit statement`).toContain(
        "omit position on create",
      );
      expect(text, `${path.join(" ")}: nesting not attributed`).toContain(
        "parentelementid",
      );
    }
  });

  it("points spec draft at the published schema instead of the source", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("cctl spec schema");
  });

  /**
   * The batch form is only learnable from the CLI if `--help` shows the shape
   * AND says where the compare-and-swap lives; a caller who reads it as a
   * whole-document write loses the element-granular boundary.
   */
  it("teaches the batch draft form with a worked example and its per-element CAS", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("cctl spec draft <slug> --file <elements.json>");
    expect(text).toContain("baseElementVersion");
    expect(text).toContain("one transaction");
    expect(text).toContain("cctl spec schema element-batch");
  });

  /**
   * A refusal an agent cannot look up teaches nothing but retrying, and a
   * repeat ask that returns the existing record must not read as an escalation.
   */
  it("names how a request-approval ask can be refused and what a repeat does", async () => {
    const text = await helpText(["spec", "request-approval"]);

    for (const code of [
      "stale_revision",
      "gate_not_applicable",
      "invalid_subject",
      "already_satisfied",
    ]) {
      expect(text, `request-approval help omits ${code}`).toContain(code);
    }
    expect(text).toContain("alreadyRequested");
  });

  /**
   * The delivery example must promise exactly what the verb does — it records
   * a durable request; the gate still halts at final publish until a human
   * grants it. Wording that implied the run parks instead of halting was a
   * false promise.
   */
  it("shows a delivery-gate example that does not overpromise halt semantics", async () => {
    const text = await helpText(["spec", "request-approval"]);

    expect(text).toContain(
      "cctl spec request-approval audit-log --gate delivery",
    );
    expect(text).toContain(
      "the gate still stops at final publish until a human grants it",
    );
  });

  it("offers project-wide discovery from the search node", async () => {
    const text = await helpText(["spec", "search"]);

    expect(text).toContain("cctl spec search --all <query>");
  });
});
