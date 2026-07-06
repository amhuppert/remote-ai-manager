import { describe, expect, it } from "vitest";

import type {
  TaskRunResult,
  TaskRunUsage,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  COMMIT_MESSAGE_JSON_SCHEMA,
  commitMessageOutputSchema,
} from "./schemas";
import {
  buildGenerationPrompt,
  defaultMessage,
  resolveGeneratedMessage,
  type GenerationContext,
} from "./generation";

const usage: TaskRunUsage = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

function structuredResult(structuredOutput: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput,
    text: "",
    usage,
    backendRef: null,
  };
}

const commitContext: GenerationContext = {
  command: "commit",
  hint: "",
  sessionName: "fix-login",
  branchName: "csm/fix-login",
  targetBranch: null,
  changeSummary: " M src/lib/auth/login.ts\n 1 file changed, 4 insertions(+)",
};

const mergeContext: GenerationContext = {
  command: "merge",
  hint: "focus on the API surface",
  sessionName: "fix-login",
  branchName: "csm/fix-login",
  targetBranch: "main",
  changeSummary: " M src/lib/auth/login.ts\n 1 file changed, 4 insertions(+)",
};

describe("commitMessageOutputSchema", () => {
  it("accepts an object with a string message", () => {
    expect(
      commitMessageOutputSchema.safeParse({ message: "Fix login" }).success,
    ).toBe(true);
  });

  it("accepts an optional resolutionContext string alongside the message", () => {
    expect(
      commitMessageOutputSchema.safeParse({
        message: "Fix login",
        resolutionContext: "Reworked the redirect flow to use the session id.",
      }).success,
    ).toBe(true);
  });

  it("rejects payloads without a string message", () => {
    expect(commitMessageOutputSchema.safeParse({ message: 42 }).success).toBe(
      false,
    );
    expect(commitMessageOutputSchema.safeParse({}).success).toBe(false);
  });
});

describe("COMMIT_MESSAGE_JSON_SCHEMA", () => {
  it("describes a required message string and an optional resolutionContext", () => {
    expect(COMMIT_MESSAGE_JSON_SCHEMA).toMatchObject({
      type: "object",
      properties: {
        message: { type: "string" },
        resolutionContext: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    });
  });
});

describe("buildGenerationPrompt", () => {
  it("embeds the change summary and branch for a commit", () => {
    const prompt = buildGenerationPrompt(commitContext);
    expect(prompt).toContain(commitContext.changeSummary);
    expect(prompt).toContain("csm/fix-login");
    expect(prompt).toContain("fix-login");
  });

  it("identifies source and target branches for a merge", () => {
    const prompt = buildGenerationPrompt(mergeContext);
    expect(prompt).toContain("csm/fix-login");
    expect(prompt).toContain("main");
  });

  it("includes the hint when provided", () => {
    const prompt = buildGenerationPrompt(mergeContext);
    expect(prompt).toContain("focus on the API surface");
  });

  it("omits hint steering when the hint is empty", () => {
    const prompt = buildGenerationPrompt(commitContext);
    expect(prompt.toLowerCase()).not.toContain("hint");
  });

  it("instructs the agent its only task is the commit message", () => {
    const prompt = buildGenerationPrompt(commitContext);
    expect(prompt.toLowerCase()).toContain("only task");
    expect(prompt.toLowerCase()).toContain("commit message");
  });

  it("asks for resolutionContext notes on a merge", () => {
    const prompt = buildGenerationPrompt(mergeContext);
    expect(prompt).toContain("resolutionContext");
    expect(prompt.toLowerCase()).toContain("conflict");
  });

  it("asks for branch-name-explicit resolutionContext phrasing on a merge", () => {
    const prompt = buildGenerationPrompt(mergeContext);
    expect(prompt).toContain("`csm/fix-login`");
    expect(prompt.toLowerCase()).toContain('not "this branch"');
  });

  it("does not ask for resolutionContext on a standalone commit", () => {
    const prompt = buildGenerationPrompt(commitContext);
    expect(prompt).not.toContain("resolutionContext");
  });
});

describe("resolveGeneratedMessage", () => {
  it("returns ok with the trimmed message for a valid structured result", () => {
    const result = resolveGeneratedMessage(
      structuredResult({ message: "  Fix login redirect loop  " }),
    );
    expect(result).toEqual({ ok: true, message: "Fix login redirect loop" });
  });

  it("returns the trimmed resolutionContext when the structured result carries one", () => {
    const result = resolveGeneratedMessage(
      structuredResult({
        message: "Fix login",
        resolutionContext: "  Reworked the redirect flow.  ",
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: "Fix login",
      resolutionContext: "Reworked the redirect flow.",
    });
  });

  it("omits resolutionContext when it is absent or blank", () => {
    expect(
      resolveGeneratedMessage(structuredResult({ message: "Fix login" })),
    ).toEqual({ ok: true, message: "Fix login" });
    expect(
      resolveGeneratedMessage(
        structuredResult({ message: "Fix login", resolutionContext: "   " }),
      ),
    ).toEqual({ ok: true, message: "Fix login" });
  });

  it("rejects a structured result whose message is empty after trimming", () => {
    const result = resolveGeneratedMessage(
      structuredResult({ message: "   " }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("empty");
  });

  it("rejects a structured result whose payload does not match the schema", () => {
    const result = resolveGeneratedMessage(
      structuredResult({ msg: "wrong shape" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("rejects a text result", () => {
    const result = resolveGeneratedMessage({
      kind: "text",
      text: "Fix login",
      usage,
      backendRef: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("text");
  });

  it("rejects an error result and surfaces the error in the reason", () => {
    const result = resolveGeneratedMessage({
      kind: "error",
      error: "backend exploded",
      aborted: false,
      usage,
      backendRef: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("backend exploded");
  });

  it("rejects an aborted (timeout) error result with a distinguishable reason", () => {
    const result = resolveGeneratedMessage({
      kind: "error",
      error: "timed out",
      aborted: true,
      usage,
      backendRef: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("aborted");
  });
});

describe("defaultMessage", () => {
  it("identifies source and target branches for a merge", () => {
    expect(defaultMessage(mergeContext)).toBe("Merge csm/fix-login into main");
  });

  it("identifies the session for a standalone commit", () => {
    expect(defaultMessage(commitContext)).toBe(
      "Changes from session fix-login",
    );
  });
});
