import { describe, expect, it } from "vitest";
import { ApiCallError } from "@/lib/api/errors";
import type { MissingPrerequisite } from "@/lib/workflow-graph/preflight-prerequisite-service";
import { mapLaunchOutcome } from "./launch-outcome";

describe("mapLaunchOutcome", () => {
  it("maps a successful start to `started`", () => {
    expect(mapLaunchOutcome({ kind: "success" })).toEqual({
      status: "started",
    });
  });

  it("maps a prerequisites_unmet ApiCallError to an itemized prerequisites_unmet outcome", () => {
    const missing: MissingPrerequisite[] = [
      {
        kind: "path",
        path: ".kiro",
        label: "Kiro directory",
        reason: "absent",
      },
      {
        kind: "skill",
        skill: "kiro-spec-design",
        backend: "claude",
        label: null,
        reason: "probe_error",
      },
      {
        kind: "skill",
        skill: "any-backend",
        backend: null,
        label: null,
        reason: "absent",
      },
    ];

    const error = new ApiCallError(
      "Prerequisites not met",
      "prerequisites_unmet",
      undefined,
      { missing },
      409,
    );

    expect(mapLaunchOutcome({ kind: "error", error })).toEqual({
      status: "prerequisites_unmet",
      missing,
    });
  });

  it("rejects with the ApiCallError message when details.missing is malformed", () => {
    const error = new ApiCallError(
      "Prerequisites not met",
      "prerequisites_unmet",
      undefined,
      { missing: [{ kind: "path" }] },
      409,
    );

    expect(mapLaunchOutcome({ kind: "error", error })).toEqual({
      status: "rejected",
      reason: "Prerequisites not met",
    });
  });

  it("rejects with the ApiCallError message when details is entirely absent", () => {
    const error = new ApiCallError(
      "Prerequisites not met",
      "prerequisites_unmet",
    );

    expect(mapLaunchOutcome({ kind: "error", error })).toEqual({
      status: "rejected",
      reason: "Prerequisites not met",
    });
  });

  it("maps any other ApiCallError to `rejected` carrying its message", () => {
    const error = new ApiCallError(
      "Session has uncommitted changes",
      "uncommitted_changes",
      undefined,
      { totalCount: 3, paths: ["a.ts"] },
      409,
    );

    expect(mapLaunchOutcome({ kind: "error", error })).toEqual({
      status: "rejected",
      reason: "Session has uncommitted changes",
    });
  });

  it("maps a non-ApiCallError thrown value to `rejected` with its message", () => {
    expect(
      mapLaunchOutcome({ kind: "error", error: new Error("network down") }),
    ).toEqual({ status: "rejected", reason: "network down" });
  });

  it("maps an unknown thrown value to a generic `rejected` outcome", () => {
    expect(mapLaunchOutcome({ kind: "error", error: "boom" })).toEqual({
      status: "rejected",
      reason: "Launch failed",
    });
  });
});
