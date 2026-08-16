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

/**
 * The plan verbs are the surface an agent authoring a delivery discovers the
 * whole model through. These pin the facts an author cannot recover from the
 * schema alone — and that a wrong guess about would produce a plan the propose
 * gate refuses for reasons the CLI never mentioned.
 */
describe("cctl spec plan help", () => {
  it("teaches the direct envelope without retired plan-dialect vocabulary", async () => {
    for (const path of [
      ["spec", "plan"],
      ["spec", "plan", "open"],
      ["spec", "plan", "edit"],
      ["spec", "plan", "propose"],
      ["spec", "plan", "reopen"],
      ["spec", "plan", "sign-off"],
      ["spec", "plan", "get"],
      ["spec", "plan", "status"],
      ["spec", "plan", "preview"],
    ]) {
      const text = await helpText(path);

      for (const retiredTerm of [
        /\bcompiler\b/i,
        /\bmaterializer\b/i,
        /\bcontext[ -]pack\b/i,
        /\bproofplan\b/i,
        /\bwiring\b/i,
      ]) {
        expect(text, `${path.join(" ")}: contains ${retiredTerm}`).not.toMatch(
          retiredTerm,
        );
      }
    }
  });

  it("teaches the total-disposition law wherever the plan is described", async () => {
    for (const path of [
      ["spec", "plan"],
      ["spec", "plan", "open"],
    ]) {
      const text = (await helpText(path)).toLowerCase();
      expect(
        text,
        `${path.join(" ")}: no total-disposition statement`,
      ).toContain("exactly one disposition");
      expect(
        text,
        `${path.join(" ")}: does not name the pinned revision`,
      ).toContain("pinned");
    }
  });

  it("names every disposition the document accepts", async () => {
    const text = await helpText(["spec", "plan"]);

    for (const disposition of [
      "selected",
      "deferred",
      "waived",
      "delivered_elsewhere",
      "reaffirmed",
      "pending_reaffirmation",
    ]) {
      expect(text, `plan help omits ${disposition}`).toContain(disposition);
    }
  });

  it("states the seeding rule per delivery class on the verb that applies it", async () => {
    const text = await helpText(["spec", "plan", "open"]);

    expect(text).toContain("delivered_elsewhere");
    expect(text).toContain("pending_reaffirmation");
    expect(text).toContain("hard-stale");
    expect(text).toContain("deferred");
  });

  it("states the compare-and-swap contract on the verb that enforces it", async () => {
    const text = await helpText(["spec", "plan", "edit"]);

    expect(text).toContain("expectedDraftRevision");
    expect(text).toContain("cctl spec plan get");
    expect(text).toContain("cctl spec schema plan-edit");
  });

  it("says a re-propose after a reopen needs a new approval", async () => {
    const text = await helpText(["spec", "plan", "propose"]);

    expect(text).toContain("new hash");
    expect(text).toContain("new approval");
  });

  it("names the post-launch paths on the verb that refuses a launched attempt", async () => {
    const text = await helpText(["spec", "plan", "reopen"]);

    expect(text).toContain("capture");
    expect(text).toContain("abandon");
    expect(text).toContain("two post-launch paths");
  });

  it("states the ten-item section cap on both read verbs", async () => {
    for (const path of [
      ["spec", "plan", "get"],
      ["spec", "plan", "status"],
    ]) {
      const text = await helpText(path);
      expect(text, `${path.join(" ")}: no cap statement`).toContain(
        "bounded to ten items each",
      );
      expect(text, `${path.join(" ")}: no omission accounting`).toContain(
        "omitted",
      );
    }
  });
});
