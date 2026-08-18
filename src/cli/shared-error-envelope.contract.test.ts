import { describe, expect, it } from "vitest";

import {
  cliRequest,
  failureFromRequest,
  type CliHost,
  type JsonEnvelope,
} from "./shared";

function hostReturning(status: number, body: unknown): CliHost {
  return {
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    readTextFile: async () => null,
    readFileBytes: async () => null,
    sleep: async () => {},
    platform: "darwin",
    homedir: "/home/test",
  };
}

async function classify(status: number, body: unknown) {
  return cliRequest(hostReturning(status, body), {
    server: "http://127.0.0.1:3000",
    token: null,
    tokenSource: null,
    method: "POST",
    path: "/api/test",
  });
}

describe("shared CLI refusal-envelope contract", () => {
  it("uses the first unmet condition as the message when a refusal omits error", async () => {
    const message =
      'Spec element ID "sec-problem" is already used by spec "spec-existing"; element IDs are globally unique.';
    const result = await classify(409, {
      code: "element_id_taken",
      unmetConditions: [message],
      instruction:
        "Choose a globally unique element ID prefixed with the spec slug, then retry.",
    });

    expect(result).toMatchObject({
      kind: "error",
      error: message,
      code: "element_id_taken",
    });
    if (result.kind !== "error") throw new Error("expected error result");

    const rendered = failureFromRequest(result, false);
    expect(rendered.exitCode).toBe(1);
    expect(rendered.stderr.startsWith(message)).toBe(true);
    expect(rendered.stderr.split(message)).toHaveLength(2);
  });

  it.each([
    [400, "validation", 2],
    [422, "validation", 2],
    [409, "gate_blocked", 1],
    [409, "unresolvable_evidence", 1],
    [409, "invalid_scope", 1],
  ] as const)(
    "maps HTTP %i / %s to exit %i with issues and instruction",
    async (status, code, exitCode) => {
      const instruction = `Resolve ${code} and retry.`;
      const result = await classify(status, {
        error: `${code} refusal`,
        code,
        unmetConditions: [`${code} condition`],
        instruction,
      });

      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected error result");
      expect(result).toMatchObject({
        status,
        code,
        issues: [{ path: "unmetConditions[0]", message: `${code} condition` }],
        instruction,
      });

      const rendered = failureFromRequest(result, true);
      expect(rendered.exitCode).toBe(exitCode);
      expect(JSON.parse(rendered.stdout) as JsonEnvelope).toMatchObject({
        ok: false,
        code,
        issues: [{ path: "unmetConditions[0]", message: `${code} condition` }],
        instruction,
      });
    },
  );

  // The one 409 that is not "server said no": the request was refused before
  // the handler ran, which is the version-mismatch exit, not an operation
  // failure the caller could retry as-is.
  it("maps a build_skew 409 to exit 4 with its recovery details intact", async () => {
    const details = {
      serverBuild: "server-sha",
      serverCliPath: "/srv/cc/bin/cctl",
    };
    const result = await classify(409, {
      error: "cctl build cli-sha does not match server build server-sha",
      code: "build_skew",
      details,
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");

    const rendered = failureFromRequest(result, true);
    expect(rendered.exitCode).toBe(4);
    expect(JSON.parse(rendered.stdout) as JsonEnvelope).toMatchObject({
      ok: false,
      code: "build_skew",
      details,
    });
    const text = failureFromRequest(result, false);
    expect(text.stderr).toContain("no changes were made");
    expect(text.stderr).toContain("/srv/cc/bin/cctl");
  });

  it("carries lint_blocked findings in code-discriminated details", async () => {
    const findings = [
      {
        ruleId: "criterion_coverage",
        severity: "blocks_propose",
        elementHandle: "R3.2",
        message: "R3.2 has no covering task",
      },
    ];
    const result = await classify(409, {
      code: "lint_blocked",
      unmetConditions: findings.map((finding) => finding.message),
      findings,
      instruction: "Resolve the blocking lint findings and propose again.",
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.details).toEqual({ findings });

    const rendered = failureFromRequest(result, true);
    expect(rendered.exitCode).toBe(1);
    expect(JSON.parse(rendered.stdout) as JsonEnvelope).toMatchObject({
      code: "lint_blocked",
      details: { findings },
      instruction: "Resolve the blocking lint findings and propose again.",
    });
    const text = failureFromRequest(result, false);
    expect(text.stderr).toContain("R3.2 [criterion_coverage/blocks_propose]");
  });

  it("carries stale_element current content and version in code-discriminated details", async () => {
    const currentContent = {
      kind: "requirement",
      title: "Current title",
      description: "Current content",
    };
    const result = await classify(409, {
      code: "stale_element",
      unmetConditions: ["R3 changed after it was read."],
      details: { currentContent, currentVersion: 7 },
      instruction: "Reconcile the current content and retry with version 7.",
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.details).toEqual({ currentContent, currentVersion: 7 });

    const rendered = failureFromRequest(result, true);
    expect(rendered.exitCode).toBe(1);
    expect(JSON.parse(rendered.stdout) as JsonEnvelope).toMatchObject({
      code: "stale_element",
      details: { currentContent, currentVersion: 7 },
      instruction: "Reconcile the current content and retry with version 7.",
    });
    const text = failureFromRequest(result, false);
    expect(text.stderr).toContain("details.currentVersion: 7");
    expect(text.stderr).toContain('"description":"Current content"');
  });
});
