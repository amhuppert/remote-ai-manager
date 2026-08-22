import { describe, expect, it } from "vitest";
import {
  ADVISORY_ORIGIN,
  OUTPUT_SCHEMA_REPAIR,
  nextNavigationRequest,
  resolveNavigationRequest,
} from "./navigation";

const ADVISORY = { roundSeq: 7, assignmentId: "security", ordinal: 2 };

describe("nextNavigationRequest", () => {
  it("names the context and the destination the caller asked for", () => {
    expect(
      nextNavigationRequest(null, "context-implement", OUTPUT_SCHEMA_REPAIR),
    ).toEqual({
      contextId: "context-implement",
      tab: "config",
      screen: ["brief", "schema"],
      seq: 1,
    });
  });

  it("makes a repeat of the same request distinguishable from the last one", () => {
    const first = nextNavigationRequest(
      null,
      "context-implement",
      OUTPUT_SCHEMA_REPAIR,
    );
    const second = nextNavigationRequest(
      first,
      "context-implement",
      OUTPUT_SCHEMA_REPAIR,
    );

    expect(second.seq).toBe(2);
    expect(second).not.toEqual(first);
  });

  it("carries the advisory a link is aimed at, not just its round number", () => {
    expect(
      nextNavigationRequest(null, "context-plan", ADVISORY_ORIGIN(ADVISORY)),
    ).toEqual({
      contextId: "context-plan",
      tab: "history",
      advisory: ADVISORY,
      seq: 1,
    });
  });
});

describe("resolveNavigationRequest", () => {
  const request = nextNavigationRequest(
    null,
    "context-implement",
    OUTPUT_SCHEMA_REPAIR,
  );

  it("opens the destination for the context the request names", () => {
    expect(
      resolveNavigationRequest(request, "context-implement", null),
    ).toEqual({ tab: "config", screen: ["brief", "schema"] });
  });

  it("leaves another context where the reader left it", () => {
    expect(resolveNavigationRequest(request, "context-plan", null)).toBeNull();
  });

  it("does not re-open a destination the reader has since navigated away from", () => {
    expect(
      resolveNavigationRequest(request, "context-implement", request.seq),
    ).toBeNull();
  });

  it("has nothing to resolve without a request", () => {
    expect(
      resolveNavigationRequest(null, "context-implement", null),
    ).toBeNull();
  });

  it("re-opens after a second, distinct request for the same destination", () => {
    const second = nextNavigationRequest(
      request,
      "context-implement",
      OUTPUT_SCHEMA_REPAIR,
    );

    expect(
      resolveNavigationRequest(second, "context-implement", request.seq),
    ).toEqual({ tab: "config", screen: ["brief", "schema"] });
  });

  it("resolves an advisory link to the advisory it names", () => {
    expect(
      resolveNavigationRequest(
        nextNavigationRequest(null, "context-plan", ADVISORY_ORIGIN(ADVISORY)),
        "context-plan",
        null,
      ),
    ).toEqual({ tab: "history", advisory: ADVISORY });
  });
});
