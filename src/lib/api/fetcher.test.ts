import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiCallError } from "./errors";
import { mutationFetch } from "./fetcher";

/**
 * Stub only the global `fetch` (infrastructure) — `mutationFetch` calls
 * `tracedFetch`, which resolves the module-global `fetch`. Everything under test
 * (the error-body classification) is real production code.
 */
function stubFetchResponse(body: unknown, status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("mutationFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("threads structured `issues` from a 400 body onto the thrown ApiCallError", async () => {
    stubFetchResponse(
      {
        error: "Workflow plan is invalid",
        issues: [
          { path: "definition.tasks.0.contextId", message: "unknown context" },
          { path: "name", message: "Too small: expected string" },
        ],
      },
      400,
    );

    const promise = mutationFetch("/api/projects/repo/workflows", "create", {
      method: "POST",
    });

    await expect(promise).rejects.toBeInstanceOf(ApiCallError);
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiCallError);
    if (error instanceof ApiCallError) {
      expect(error.message).toBe("Workflow plan is invalid");
      expect(error.issues).toEqual([
        { path: "definition.tasks.0.contextId", message: "unknown context" },
        { path: "name", message: "Too small: expected string" },
      ]);
    }
  });

  it("leaves `issues` undefined when the error body omits it", async () => {
    stubFetchResponse({ error: "Workflow not found" }, 404);

    const error = await mutationFetch("/api/projects/repo/workflows/x", "get", {
      method: "GET",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiCallError);
    if (error instanceof ApiCallError) {
      expect(error.message).toBe("Workflow not found");
      expect(error.issues).toBeUndefined();
    }
  });

  it("surfaces refusal conditions and the server instruction when no generic error is present", async () => {
    stubFetchResponse(
      {
        code: "gate_blocked",
        unmetConditions: [
          "Execution plan needs a valid approval for revision-1.",
        ],
        instruction: "Resolve the sign-off preconditions and sign off again.",
      },
      409,
    );

    const error = await mutationFetch(
      "/api/specs/demo/actions/sign-off",
      "sign-off",
      {
        method: "POST",
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiCallError);
    if (error instanceof ApiCallError) {
      expect(error.code).toBe("gate_blocked");
      expect(error.message).toBe(
        "Execution plan needs a valid approval for revision-1. Resolve the sign-off preconditions and sign off again.",
      );
      expect(error.issues).toEqual([
        {
          path: "unmetConditions[0]",
          message: "Execution plan needs a valid approval for revision-1.",
        },
      ]);
      expect(error.details).toEqual({
        unmetConditions: [
          "Execution plan needs a valid approval for revision-1.",
        ],
        instruction: "Resolve the sign-off preconditions and sign off again.",
      });
    }
  });
});
