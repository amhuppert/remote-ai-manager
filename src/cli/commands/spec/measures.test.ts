import { describe, expect, it } from "vitest";

import { MEASURE_DEFINITIONS_VERSION } from "@/lib/specs/measures";
import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

const responseBody = {
  definitionsVersion: MEASURE_DEFINITIONS_VERSION,
  requirementCausedRework: {
    reopenedClaimCount: 1,
    postApprovalRevisionCount: 0,
    totalReworkEventCount: 1,
    claimIds: ["claim-1"],
    revisionIds: [],
  },
  approvalFriction: {
    activeReviewTimeMs: 2_000,
    interventionCount: 1,
    reapprovalLoopCount: 0,
  },
  traceabilityCompleteness: {
    deliveredInScopeCriterionCount: 1,
    completeChainCount: 1,
    share: 1,
    completeCriterionIds: ["criterion-1"],
    incompleteCriterionIds: [],
  },
  automaticEvidenceCapture: {
    automaticallyIngestedCount: 1,
    manuallyAttachedCount: 0,
    totalEvidenceCount: 1,
    share: 1,
  },
  navigationChains: [],
};

const env: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_PROJECT: "demo",
};

describe("cctl spec measures", () => {
  it("returns the four measures and frozen definitions version", async () => {
    const host: CliHost = {
      async fetch(url, init) {
        expect(new URL(url).pathname).toBe("/api/projects/demo/spec-measures");
        expect(init.method).toBe("GET");
        return Response.json(responseBody);
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

    const result = await runCcWithHost(
      ["spec", "measures", "--json"],
      env,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).payload.data).toEqual(responseBody);
  });
});
