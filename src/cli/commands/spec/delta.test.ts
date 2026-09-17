import { describe, expect, it } from "vitest";

import type { DeliveryDeltaProjection } from "@/lib/specs/delivery-delta";
import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

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
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl spec delta", () => {
  it("reads the delivery-delta projection for the spec", async () => {
    const calls: HostCall = { url: "" };
    const result = await runCcWithHost(
      ["spec", "delta", "native-sdd", "--json"],
      env,
      hostFor(projection(), calls),
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(calls.url).pathname).toBe(
      "/api/specs/demo/native-sdd/delta",
    );
    expect(new URL(calls.url).search).toBe("");
    expect(JSON.parse(result.stdout).payload.data.delta).toMatchObject({
      specSlug: "native-sdd",
      current: { revisionNumber: 3 },
      comparedExecution: { workflowExecutionId: "workflow-exec-new" },
    });
  });

  it("passes --since through as the compared execution", async () => {
    const calls: HostCall = { url: "" };
    await runCcWithHost(
      ["spec", "delta", "native-sdd", "--since", "exec-old"],
      env,
      hostFor(projection(), calls),
    );

    expect(new URL(calls.url).searchParams.get("since")).toBe("exec-old");
  });

  it("bounds each collection and reports total, shown, and its full continuation", async () => {
    const calls: HostCall = { url: "" };
    const elements = Array.from({ length: 42 }, (_, index) =>
      addedElement(index + 1),
    );
    const result = await runCcWithHost(
      ["spec", "delta", "native-sdd", "--json"],
      env,
      hostFor(projection({ elements }), calls),
    );

    const data = JSON.parse(result.stdout).payload.data;
    expect(data.delta.elements).toHaveLength(10);
    expect(data.delta.elements[0]).toMatchObject({
      handle: "R1",
      kind: "requirement",
    });
    expect(data.delta.elements[9]).toMatchObject({ handle: "R10" });
    expect(data.disclosure.elements).toMatchObject({
      returned: 10,
      total: { kind: "known", count: 42 },
      truncated: true,
    });
    expect(JSON.stringify(data.disclosure.elements.reveal)).toContain("full");
  });

  it("returns every delivery-delta element in the full projection", async () => {
    const calls: HostCall = { url: "" };
    const elements = Array.from({ length: 11 }, (_, index) =>
      addedElement(index + 1),
    );
    const body = projection({ elements });
    const result = await runCcWithHost(
      ["spec", "delta", "native-sdd", "--full", "--json"],
      env,
      hostFor(body, calls),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).payload.data.delta).toEqual(body);
  });

  it("renders criterion classes with their staleness basis and the advisory remedy", async () => {
    const calls: HostCall = { url: "" };
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

    const result = await runCcWithHost(
      ["spec", "delta", "native-sdd", "--json"],
      env,
      hostFor(body, calls),
    );

    const data = JSON.parse(result.stdout).payload.data;
    expect(data.delta.criteria).toEqual(body.criteria);
    expect(data.delta.advisories).toEqual(body.advisories);
    expect(data.disclosure.criteria).toMatchObject({
      returned: 1,
      total: { kind: "known", count: 1 },
      truncated: false,
    });
  });

  it("reports no comparison basis when no execution has delivered yet", async () => {
    const calls: HostCall = { url: "" };
    const result = await runCcWithHost(
      ["spec", "delta", "native-sdd", "--json"],
      env,
      hostFor(projection({ base: null, comparedExecution: null }), calls),
    );

    expect(JSON.parse(result.stdout).payload.data.delta).toMatchObject({
      base: null,
      comparedExecution: null,
    });
  });
});
