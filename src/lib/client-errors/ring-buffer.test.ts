// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createClientErrorRingBuffer,
  initializeClientErrorCapture,
  resetClientErrorCaptureForTesting,
  sanitizeClientError,
} from "./ring-buffer";

beforeEach(() => {
  resetClientErrorCaptureForTesting();
});

afterEach(() => {
  resetClientErrorCaptureForTesting();
  vi.restoreAllMocks();
});

describe("client error sanitization", () => {
  it("accepts only strings and Errors, strips URL queries, redacts credentials, and bounds text", () => {
    const capturedAt = new Date("2026-07-19T12:00:00.000Z");
    const entry = sanitizeClientError(
      "console",
      new Error(
        `GET https://cc.test/api/tickets?token=hunter2 failed Bearer abc.def.ghi password=secret ${"x".repeat(800)}`,
      ),
      capturedAt,
    );

    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      ts: capturedAt.toISOString(),
      kind: "console",
    });
    expect(entry?.message).toContain("https://cc.test/api/tickets");
    expect(entry?.message).not.toContain("hunter2");
    expect(entry?.message).not.toContain("abc.def.ghi");
    expect(entry?.message).not.toContain("password=secret");
    expect(entry?.message.length).toBeLessThanOrEqual(500);
    expect(entry?.stackHead).toHaveLength(3);
    expect(entry?.stackHead.every((line) => line.length <= 500)).toBe(true);

    expect(
      sanitizeClientError(
        "console",
        { secret: "never stringify me" },
        capturedAt,
      ),
    ).toBeNull();
  });

  it("keeps only the newest 25 entries in chronological order", () => {
    const buffer = createClientErrorRingBuffer(25);
    for (let index = 0; index < 30; index += 1) {
      buffer.capture(
        "window",
        `failure-${index}`,
        new Date(Date.UTC(2026, 6, 19, 12, 0, index)),
      );
    }

    const entries = buffer.read();
    expect(entries).toHaveLength(25);
    expect(entries[0]?.message).toBe("failure-5");
    expect(entries.at(-1)?.message).toBe("failure-29");
  });

  it("removes URL userinfo before retaining a captured URL", () => {
    const entry = sanitizeClientError(
      "window",
      "GET https://alice:secret@example.com/private?token=hunter2 failed",
      new Date("2026-07-19T12:00:00.000Z"),
    );

    expect(entry?.message).toBe("GET https://example.com/private failed");
    expect(entry?.message).not.toMatch(/alice|secret|hunter2/);
  });

  it.each([
    {
      name: "quoted JSON credentials",
      input:
        'response body {"access_token":"top-secret","status":"expired"} was rejected',
      expected:
        'response body {"access_token":"[redacted]","status":"expired"} was rejected',
      secrets: ["top-secret"],
    },
    {
      name: "Basic authorization headers",
      input:
        "request failed with Authorization: Basic YWxleDpzdXBlci1zZWNyZXQ= while fetching tickets",
      expected:
        "request failed with Authorization: Basic [redacted] while fetching tickets",
      secrets: ["YWxleDpzdXBlci1zZWNyZXQ="],
    },
    {
      name: "cookie header values",
      input: "request failed: Cookie: sid=private-cookie; theme=dark; retrying",
      expected:
        "request failed: Cookie: sid=[redacted]; theme=[redacted]; retrying",
      secrets: ["private-cookie", "dark"],
    },
    {
      name: "session assignments",
      input: "database refused session_id=also-private during retry",
      expected: "database refused session_id=[redacted] during retry",
      secrets: ["also-private"],
    },
  ])(
    "redacts $name while preserving surrounding text",
    ({ input, expected, secrets }) => {
      const entry = sanitizeClientError(
        "window",
        input,
        new Date("2026-07-19T12:00:00.000Z"),
      );

      expect(entry?.message).toBe(expected);
      for (const secret of secrets) {
        expect(entry?.message).not.toContain(secret);
      }
    },
  );
});

describe("client error capture installation", () => {
  it("guards against duplicate installation while capturing console, window, rejection, and query errors", async () => {
    const originalConsoleError = console.error;
    const passthrough = vi.fn();
    console.error = passthrough;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const first = initializeClientErrorCapture(queryClient);
    const wrappedConsoleError = console.error;
    const second = initializeClientErrorCapture(queryClient);

    expect(console.error).toBe(wrappedConsoleError);
    console.error("console token=super-secret");
    window.dispatchEvent(
      new ErrorEvent("error", { message: "window failure?api_key=hidden" }),
    );
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: new Error("rejection Bearer opaque-token"),
      }),
    );
    await queryClient
      .fetchQuery({
        queryKey: ["failing-query"],
        queryFn: () => Promise.reject(new Error("query failed?password=nope")),
      })
      .catch(() => undefined);

    expect(first.read().map((entry) => entry.kind)).toEqual([
      "console",
      "window",
      "unhandledrejection",
      "query",
    ]);
    expect(second.read()).toEqual(first.read());
    expect(
      first
        .read()
        .map((entry) => entry.message)
        .join(" "),
    ).not.toMatch(/super-secret|hidden|opaque-token|nope/);
    expect(passthrough).toHaveBeenCalledWith("console token=super-secret");

    console.error = originalConsoleError;
  });
});
