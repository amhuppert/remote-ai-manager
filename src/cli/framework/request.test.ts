import { describe, expect, it } from "vitest";
import { recoveryFacts } from "cli-for-agents";
import { cliRequest, type CliHost } from "../transport";
import {
  ccRequestError,
  ccRequestFailure,
  ccWriteFailure,
  type CcFailedRequest,
} from "./request";

const recovery = recoveryFacts([{ kind: "session", id: "session" }]);

describe("native CC request results", () => {
  it.each([
    "Read these findings:\nThen retry.",
    "Required recovery step. ".repeat(80),
  ])(
    "preserves server instructions that need a quoted or artifact representation",
    (instructionText) => {
      const report = ccWriteFailure(
        {
          kind: "error",
          status: 409,
          error: "Write refused.",
          instruction: instructionText,
        },
        recovery,
      );
      expect(report).toMatchObject({
        effect: "not_applied",
        result: {
          error: { details: { serverInstruction: instructionText } },
          instruction: { ownerId: "cc-server-refusal" },
        },
      });
      expect(report.result.instruction?.text).toContain("serverInstruction");
      expect(report.result.instruction?.text).toContain("before continuing");
    },
  );

  it.each(["First line\nSecond line", "x".repeat(600)])(
    "retains unbounded or multiline refusal prose in structured detail",
    (message) => {
      const report = ccWriteFailure(
        {
          kind: "error",
          status: 409,
          error: message,
          rationale: message,
          issues: [{ path: "body", message }],
        },
        recovery,
      );
      expect(report).toMatchObject({
        effect: "not_applied",
        result: {
          error: {
            code: "CC_OPERATION_FAILED",
            details: {
              serverMessage: message,
              serverRationale: message,
              serverIssues: [{ path: "body", message }],
            },
          },
        },
      });
      expect(report.result.error.message).not.toContain("\n");
      expect(report.result.error.issues?.[0]?.message).not.toContain("\n");
    },
  );

  it("maps server refusal data and authenticated instructions to CC errors", async () => {
    const host: CliHost = {
      async fetch() {
        return Response.json(
          {
            error: "This element changed since it was read.",
            code: "stale_element",
            rationale: "The revision token protects another author's edit.",
            details: {
              currentVersion: 3,
              currentContent: { title: "Current title" },
            },
            issues: [
              {
                path: "requirements[0].id",
                message: "Re-read this element.",
                recordId: "R1",
              },
            ],
            instruction:
              "Read the current element, then retry with its new version.",
            reminders: ["Do not claim a local rule fired from server prose."],
          },
          { status: 409 },
        );
      },
      async readTextFile() {
        return null;
      },
      async readFileBytes() {
        return null;
      },
      async sleep() {},
      homedir: "/Users/test",
      platform: "darwin",
    };
    const response = await cliRequest(host, {
      server: "http://cc.test",
      token: "token",
      tokenSource: "env",
      method: "POST",
      path: "/api/example",
    });
    expect(response.kind).toBe("error");
    if (response.kind === "ok") throw new Error("Expected server refusal");
    const failure = ccRequestFailure(response);
    expect(failure.instruction).toMatchObject({
      ownerId: "cc-server-refusal",
      text: "Read the current element, then retry with its new version.",
    });

    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: "CC_OPERATION_FAILED",
        why: "The revision token protects another author's edit.",
        details: {
          serverCode: "stale_element",
          serverDetails: {
            currentVersion: 3,
            currentContent: { title: "Current title" },
          },
          serverIssues: [
            {
              path: "requirements[0].id",
              message: "Re-read this element.",
              recordId: "R1",
            },
          ],
        },
        issues: [
          {
            code: "CC_INPUT_ISSUE",
            path: ["requirements[0].id"],
            message: "Re-read this element.",
          },
        ],
      },
    });
    expect(failure).not.toHaveProperty("reminders");
  });

  it.each([
    [{ kind: "connection", detail: "ECONNRESET" }, "unknown", "CC_CONNECTION"],
    [
      { kind: "error", status: 503, error: "Unavailable" },
      "unknown",
      "CC_OPERATION_FAILED",
    ],
    [
      { kind: "auth", hadToken: true, tokenSource: "env" },
      "not_applied",
      "CC_CONNECTION",
    ],
    [
      { kind: "version_mismatch", cliBuild: "old", serverBuild: "new" },
      "not_applied",
      "CC_BUILD_MISMATCH",
    ],
    [
      { kind: "error", status: 422, error: "Invalid payload" },
      "not_applied",
      "CC_USAGE",
    ],
    [
      { kind: "error", status: 409, error: "Refused" },
      "not_applied",
      "CC_OPERATION_FAILED",
    ],
  ] satisfies Array<[CcFailedRequest, string, string]>)(
    "classifies mutation outcome for %j",
    (response, effect, code) => {
      const report = ccWriteFailure(response, recovery);
      expect(report).toMatchObject({
        effect,
        result: { ok: false, error: { code } },
      });
      if (effect === "unknown")
        expect(report).toHaveProperty("recovery", recovery);
      else expect(report).not.toHaveProperty("recovery");
    },
  );

  it("retains source metadata even when the server supplies no code", () => {
    expect(
      ccRequestError({
        kind: "error",
        status: 400,
        error: "Bad input",
        details: { field: "title" },
      }),
    ).toMatchObject({
      code: "CC_USAGE",
      details: { serverDetails: { field: "title" } },
    });
  });
  it("lets domains classify a semantic refusal without discarding diagnostics or instructions", () => {
    const response: CcFailedRequest = {
      kind: "error",
      status: 404,
      code: "ticket_not_found",
      error: "Ticket no longer exists",
      details: { ticketNumber: 42 },
      instruction: "Read the ticket list before retrying.",
    };
    const report = ccWriteFailure(response, recovery, {
      errorCode: "CC_OPERATION_FAILED",
    });
    expect(report).toMatchObject({
      effect: "not_applied",
      result: {
        error: {
          code: "CC_OPERATION_FAILED",
          details: {
            serverCode: "ticket_not_found",
            serverDetails: { ticketNumber: 42 },
          },
        },
        instruction: { text: "Read the ticket list before retrying." },
      },
    });
    expect(
      ccRequestError(
        { kind: "connection", detail: "offline" },
        { errorCode: "CC_OPERATION_FAILED" },
      ).code,
    ).toBe("CC_CONNECTION");
    expect(
      ccRequestError(
        { kind: "version_mismatch", cliBuild: "old", serverBuild: "new" },
        { errorCode: "CC_OPERATION_FAILED" },
      ).code,
    ).toBe("CC_BUILD_MISMATCH");
  });
});
