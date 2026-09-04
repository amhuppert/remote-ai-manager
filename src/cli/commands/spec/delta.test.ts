import { describe, expect, it } from "vitest";

import type { DeliveryDeltaProjection } from "@/lib/specs/delivery-delta";
import { runCli } from "../../core";
import type { CliEnv, CliHost } from "../../shared";

const env: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_PROJECT: "demo",
};

function addedElement(
  index: number,
): DeliveryDeltaProjection["elements"][number] {
  return {
    elementId: `req-${index}`,
    kind: "requirement",
    handle: `R${index}`,
    class: "added",
    baseHash: null,
    currentHash: `req-${index}-hash-abcdefghijklmnop`,
  };
}

function projection(
  overrides: Partial<DeliveryDeltaProjection> = {},
): DeliveryDeltaProjection {
  return {
    specSlug: "native-sdd",
    current: { revisionId: "rev-3", revisionNumber: 3 },
    base: { revisionId: "rev-2", revisionNumber: 2 },
    comparedExecution: {
      executionId: "exec-new",
      workflowExecutionId: "workflow-exec-new",
      revisionId: "rev-2",
      state: "delivered",
      deliveredAt: "2026-08-04T00:00:00.000Z",
    },
    elements: [],
    criteria: [],
    advisories: [],
    counts: {
      elements: { added: 0, amended: 0, unchanged: 0, removed: 0 },
      criteria: {
        delivered_and_fresh: 0,
        soft_stale: 0,
        hard_stale: 0,
        never_delivered: 0,
        deferred: 0,
        waived: 0,
      },
    },
    ...overrides,
  };
}

interface HostCall {
  url: string;
  writes: { path: string; contents: string }[];
}

function hostFor(body: DeliveryDeltaProjection, calls: HostCall): CliHost {
  return {
    async fetch(url) {
      calls.url = url;
      return Response.json(body);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile(path, contents) {
      calls.writes.push({ path, contents });
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec delta", () => {
  it("reads the delivery-delta projection for the spec", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const result = await runCli(
      ["spec", "delta", "native-sdd"],
      env,
      hostFor(projection(), calls),
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(calls.url).pathname).toBe(
      "/api/specs/demo/native-sdd/delta",
    );
    expect(new URL(calls.url).search).toBe("");
    // The compared run is named by the id the reader could pass to another
    // verb; the internal row id stays in the --json data (design 3.5, D-B).
    expect(result.stdout).toContain(
      "native-sdd: revision 3 vs execution workflow-exec-new",
    );
    expect(result.stdout).not.toMatch(/(?<![\w-])exec-new(?![\w-])/);
  });

  it("passes --since through as the compared execution", async () => {
    const calls: HostCall = { url: "", writes: [] };
    await runCli(
      ["spec", "delta", "native-sdd", "--since", "exec-old"],
      env,
      hostFor(projection(), calls),
    );

    expect(new URL(calls.url).searchParams.get("since")).toBe("exec-old");
  });

  it("caps each class listing at 30 rows and reports total, shown, and omitted", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const elements = Array.from({ length: 42 }, (_, index) =>
      addedElement(index + 1),
    );
    const result = await runCli(
      ["spec", "delta", "native-sdd"],
      env,
      hostFor(projection({ elements }), calls),
    );

    expect(result.stdout).toContain("added: 42 total, 30 shown, 12 omitted");
    expect(result.stdout).toContain("R1 (requirement)");
    expect(result.stdout).toContain("R30 (requirement)");
    expect(result.stdout).not.toContain("R31 (requirement)");
    expect(result.stdout).toContain("unchanged: 0");
    expect(result.stdout).toContain("--out <file>");
  });

  it("writes the complete uncapped projection to --out and names the file", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const elements = Array.from({ length: 42 }, (_, index) =>
      addedElement(index + 1),
    );
    const body = projection({ elements });
    const result = await runCli(
      ["spec", "delta", "native-sdd", "--out", ".cc/temp/delta.json"],
      env,
      hostFor(body, calls),
    );

    expect(result.exitCode).toBe(0);
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]?.path).toBe(".cc/temp/delta.json");
    const written: unknown = JSON.parse(calls.writes[0]?.contents ?? "null");
    expect(written).toEqual(body);
    expect(result.stdout).toContain(
      "complete projection written to .cc/temp/delta.json",
    );
  });

  it("renders criterion classes with their staleness basis and the advisory remedy", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const body = projection({
      criteria: [
        {
          criterionElementId: "crit-1",
          handle: "R1.1",
          class: "hard_stale",
          priorDisposition: "in_scope",
          freshness: {
            grade: "hard_stale",
            basis: [
              {
                elementId: "crit-1",
                kind: "criterion",
                handle: "R1.1",
                reason: "criterion_text",
                baseHash: "old",
                currentHash: "new",
              },
            ],
          },
        },
      ],
      advisories: [
        {
          criterionElementId: "crit-1",
          handle: "R1.1",
          code: "delivered_elsewhere_refused",
          freshness: "hard_stale",
          priorDisposition: "in_scope",
          message: "R1.1 changed; re-prove it. dpa-document owns enforcement.",
        },
      ],
    });

    const result = await runCli(
      ["spec", "delta", "native-sdd"],
      env,
      hostFor(body, calls),
    );

    expect(result.stdout).toContain("hard_stale: 1 total, 1 shown, 0 omitted");
    expect(result.stdout).toContain(
      "R1.1 [was in_scope] — R1.1:criterion_text",
    );
    expect(result.stdout).toContain(
      "R1.1 delivered_elsewhere_refused: R1.1 changed; re-prove it.",
    );
  });

  it("says plainly when no execution has delivered yet", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const result = await runCli(
      ["spec", "delta", "native-sdd"],
      env,
      hostFor(projection({ base: null, comparedExecution: null }), calls),
    );

    expect(result.stdout).toContain(
      "no delivered execution to compare against",
    );
  });

  it("returns the whole projection in the JSON envelope", async () => {
    const calls: HostCall = { url: "", writes: [] };
    const body = projection();
    const result = await runCli(
      ["spec", "delta", "native-sdd", "--json"],
      env,
      hostFor(body, calls),
    );

    expect(JSON.parse(result.stdout)).toEqual({ ok: true, delta: body });
  });
});
