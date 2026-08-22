import { describe, expect, it } from "vitest";

import type { AgentFailureKind, ContinuationDisposition } from "../errors";
import { markPromptNotDelivered, turnContinuationSchema } from "../errors";
import {
  CursorLocalFailure,
  createCursorFailureClassifier,
  cursorFailureDiagnostics,
} from "./failure-classifier";

const API_KEY = "key_sentinel_do_not_leak";

/**
 * Builds the shape a Cursor SDK error takes once it has crossed the worker IPC
 * boundary: the class identity is gone, but the SDK's stable `name`, `code`,
 * and `status` survive as own properties. Classification keys on those, so the
 * same verdict holds for a live instance and a rehydrated one.
 */
function sdkError(
  name: string,
  options: { code?: string; status?: number; message?: string } = {},
): Error {
  const error = new Error(options.message ?? `${name} occurred`);
  error.name = name;
  if (options.code !== undefined) Reflect.set(error, "code", options.code);
  if (options.status !== undefined)
    Reflect.set(error, "status", options.status);
  return error;
}

interface MatrixCase {
  label: string;
  error: unknown;
  kind: AgentFailureKind;
  retryable: boolean;
  disposition: ContinuationDisposition;
}

const MATRIX: readonly MatrixCase[] = [
  {
    label: "authentication (401)",
    error: sdkError("AuthenticationError", {
      code: "unauthenticated",
      status: 401,
    }),
    kind: "backend_error",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "rate limit (429)",
    error: sdkError("RateLimitError", { code: "rate_limit", status: 429 }),
    kind: "quota_exhausted",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "configuration (400)",
    error: sdkError("ConfigurationError", { status: 400 }),
    kind: "backend_error",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "configuration (404)",
    error: sdkError("ConfigurationError", { status: 404 }),
    kind: "backend_error",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "busy agent (409)",
    error: sdkError("AgentBusyError", { code: "agent_busy", status: 409 }),
    kind: "backend_error",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "network (503)",
    error: sdkError("NetworkError", { status: 503 }),
    kind: "backend_error",
    retryable: true,
    disposition: "retain",
  },
  {
    label: "network (504)",
    error: sdkError("NetworkError", { status: 504 }),
    kind: "backend_error",
    retryable: true,
    disposition: "retain",
  },
  {
    label: "agent not found",
    error: sdkError("AgentNotFoundError", {
      code: "agent_not_found",
      status: 404,
    }),
    kind: "stale_resume_ref",
    retryable: true,
    disposition: "clear",
  },
  {
    label: "unknown agent error",
    error: sdkError("UnknownAgentError"),
    kind: "backend_error",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "worker exit",
    error: new CursorLocalFailure("worker_exit", "worker exited with code 1"),
    kind: "session_died",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "stream stall",
    error: new CursorLocalFailure("stream_stall", "no event for 120000ms"),
    kind: "timeout",
    retryable: false,
    disposition: "retain",
  },
  {
    label: "invalid ref (corrupt / cross-cwd)",
    error: new CursorLocalFailure("invalid_ref", "ref not valid for this cwd"),
    kind: "stale_resume_ref",
    retryable: true,
    disposition: "clear",
  },
];

describe("cursor failure classifier", () => {
  const classifier = createCursorFailureClassifier();

  it.each(MATRIX)(
    "maps $label to $kind with $disposition",
    ({ error, kind, retryable, disposition }) => {
      const classification = classifier.classify(error);
      expect(classification.kind).toBe(kind);
      expect(classification.retryable).toBe(retryable);

      const withContinuation = classifier.classifyWithContinuation(error);
      expect(withContinuation.failure.kind).toBe(kind);
      expect(withContinuation.continuationDisposition).toBe(disposition);
    },
  );

  it("clears the ref only for genuinely invalid sessions", () => {
    const cleared = MATRIX.filter((c) => c.disposition === "clear").map(
      (c) => c.label,
    );
    expect(cleared).toStrictEqual([
      "agent not found",
      "invalid ref (corrupt / cross-cwd)",
    ]);
  });

  it("produces a disposition pair the neutral continuation contract accepts", () => {
    for (const { error } of MATRIX) {
      const { continuationDisposition } =
        classifier.classifyWithContinuation(error);
      const parsed = turnContinuationSchema.safeParse({
        backendRef:
          continuationDisposition === "clear"
            ? null
            : { backend: "cursor", ref: "agent-ref-1" },
        continuationDisposition,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("classifies by stable code when the class name is absent", () => {
    // A rehydrated error may lose `name` but keep the backend's stable code.
    expect(
      classifier.classify(sdkError("Error", { code: "agent_not_found" })).kind,
    ).toBe("stale_resume_ref");
    expect(
      classifier.classify(sdkError("Error", { code: "rate_limit" })).kind,
    ).toBe("quota_exhausted");
    expect(
      classifier.classify(sdkError("Error", { code: "agent_busy" })).kind,
    ).toBe("backend_error");
  });

  it("classifies by HTTP status when neither name nor code is present", () => {
    expect(classifier.classify(sdkError("Error", { status: 401 })).kind).toBe(
      "backend_error",
    );
    expect(classifier.classify(sdkError("Error", { status: 429 })).kind).toBe(
      "quota_exhausted",
    );
    expect(
      classifier.classify(sdkError("Error", { status: 503 })).retryable,
    ).toBe(true);
  });

  it("treats an abort as aborted rather than a backend failure", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const classification = classifier.classify(aborted);
    expect(classification.kind).toBe("aborted");
    expect(classification.retryable).toBe(false);
  });

  it("marks an undelivered worker exit retryable", () => {
    // The prompt provably never reached the agent, so a fresh worker may
    // re-dispatch it; a mid-turn exit stays non-retryable.
    const undelivered = markPromptNotDelivered(
      new CursorLocalFailure("worker_exit", "worker exited before start"),
    );
    const classification = classifier.classify(undelivered);
    expect(classification.kind).toBe("session_died");
    expect(classification.retryable).toBe(true);
    expect(
      classifier.classifyWithContinuation(undelivered).continuationDisposition,
    ).toBe("retain");
  });

  it("preserves the SDK's stable code in the message and diagnostics", () => {
    const error = sdkError("RateLimitError", {
      code: "rate_limit",
      status: 429,
      message: "Usage limit reached. Try again at 11:29 PM.",
    });

    const classification = classifier.classify(error);
    expect(classification.message).toContain("rate_limit");
    expect(classification.message).toContain("Usage limit reached");
    expect(classification.retryAfterHint).toBe("11:29 PM");

    expect(cursorFailureDiagnostics(error)).toStrictEqual({
      sdkErrorName: "RateLimitError",
      sdkCode: "rate_limit",
      sdkStatus: 429,
      localKind: null,
    });
  });

  it("re-classifies its own enriched message to the same verdict", () => {
    // A persisted failure message is re-classified when a turn result reloads;
    // the encoded code must survive that round trip.
    const original = classifier.classify(
      sdkError("AgentNotFoundError", { code: "agent_not_found" }),
    );
    const reclassified = classifier.classify(new Error(original.message));
    expect(reclassified.kind).toBe("stale_resume_ref");
    expect(
      classifier.classifyWithContinuation(new Error(original.message))
        .continuationDisposition,
    ).toBe("clear");
  });

  it("reports diagnostics for a local failure without an SDK code", () => {
    expect(
      cursorFailureDiagnostics(
        new CursorLocalFailure("stream_stall", "stalled"),
      ),
    ).toStrictEqual({
      sdkErrorName: "CursorLocalFailure",
      sdkCode: null,
      sdkStatus: null,
      localKind: "stream_stall",
    });
  });

  it("never throws on hostile or non-error input", () => {
    const cyclic: Record<string, unknown> = { name: "AuthenticationError" };
    cyclic.self = cyclic;

    for (const input of [
      null,
      undefined,
      42,
      "a string failure",
      {},
      cyclic,
      Symbol("s"),
      new Proxy(new Error("proxied"), {
        get(target, key) {
          if (key === "code") throw new Error("hostile getter");
          return Reflect.get(target, key);
        },
      }),
    ]) {
      expect(() => classifier.classify(input)).not.toThrow();
      expect(() => classifier.classifyWithContinuation(input)).not.toThrow();
      expect(() => cursorFailureDiagnostics(input)).not.toThrow();
    }
  });

  it("falls back to a non-retryable backend error for unrecognized failures", () => {
    const classification = classifier.classify(new Error("something odd"));
    expect(classification.kind).toBe("backend_error");
    expect(classification.retryable).toBe(false);
  });

  it("never echoes credential material carried on the error", () => {
    const error = sdkError("AuthenticationError", {
      code: "unauthenticated",
      status: 401,
      message: "Invalid API key",
    });
    Reflect.set(error, "apiKey", API_KEY);

    expect(JSON.stringify(classifier.classify(error))).not.toContain(API_KEY);
    expect(JSON.stringify(cursorFailureDiagnostics(error))).not.toContain(
      API_KEY,
    );
  });
});
