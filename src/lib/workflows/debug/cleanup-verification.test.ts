/**
 * Tests for the async debug cleanup-verification runner: payload parsing
 * (including the schema-failure fallback), outcome → DebugCommand mapping,
 * and error containment (a thrown verifier must surface as a
 * cleanup_verification_failed command, never a rejection).
 */
import { describe, expect, it, vi } from "vitest";
import { runDebugCleanupVerification } from "./cleanup-verification";
import type { VerifyCleanupInput } from "@/lib/workflows/conversation/types";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const CLEANUP_PAYLOAD = {
  removedInstrumentation: true,
  filesModified: ["src/a.ts"],
  grepVerificationPassed: true,
  acknowledgesManifestDeletionContract: true,
  notes: "All probes removed.",
};

const TARGET = {
  worktreePath: "/wt",
  conversationId: "conv-1",
  debugSessionId: "debug-session-1",
  attempt: 2,
};

function passingVerifier() {
  return {
    verifyCleanup: vi.fn(async (input: VerifyCleanupInput) => {
      void input;
      return {
        ok: true,
        failedConditions: [],
        missingFiles: [],
        remediationPrompt: null,
      };
    }),
  };
}

describe("runDebugCleanupVerification", () => {
  it("maps a passing verification onto cleanup_verified", async () => {
    const deps = passingVerifier();

    const command = await runDebugCleanupVerification(
      { ...TARGET, structuredOutput: CLEANUP_PAYLOAD },
      deps,
    );

    expect(command).toEqual({
      kind: "cleanup_verified",
      debugSessionId: "debug-session-1",
      attempt: 2,
    });
    expect(deps.verifyCleanup).toHaveBeenCalledWith(
      {
        worktreePath: "/wt",
        conversationId: "conv-1",
        cleanup: CLEANUP_PAYLOAD,
      },
      undefined,
    );
  });

  it("maps a failing verification onto cleanup_verification_failed with the remediation prompt", async () => {
    const deps = {
      verifyCleanup: vi.fn(async () => ({
        ok: false,
        failedConditions: ["grepVerificationPassed"],
        missingFiles: [],
        remediationPrompt: "Probe P1 still present in src/a.ts",
      })),
    };

    const command = await runDebugCleanupVerification(
      { ...TARGET, structuredOutput: CLEANUP_PAYLOAD },
      deps,
    );

    expect(command).toEqual({
      kind: "cleanup_verification_failed",
      debugSessionId: "debug-session-1",
      message: "Probe P1 still present in src/a.ts",
      attempt: 2,
    });
  });

  it("feeds the verifier a failure-shaped fallback payload when the structured output does not parse", async () => {
    const deps = passingVerifier();

    await runDebugCleanupVerification(
      { ...TARGET, structuredOutput: { totally: "wrong" } },
      deps,
    );

    expect(deps.verifyCleanup).toHaveBeenCalledWith(
      {
        worktreePath: "/wt",
        conversationId: "conv-1",
        cleanup: {
          removedInstrumentation: false,
          filesModified: [],
          grepVerificationPassed: false,
          acknowledgesManifestDeletionContract: false,
          notes: "Cleanup payload failed schema validation.",
        },
      },
      undefined,
    );
  });

  it("contains a thrown verifier as cleanup_verification_failed instead of rejecting", async () => {
    const deps = {
      verifyCleanup: vi.fn(async () => {
        throw new Error("manifest unreadable");
      }),
    };

    const command = await runDebugCleanupVerification(
      { ...TARGET, structuredOutput: CLEANUP_PAYLOAD },
      deps,
    );

    expect(command).toEqual({
      kind: "cleanup_verification_failed",
      debugSessionId: "debug-session-1",
      message: "Cleanup verification failed: manifest unreadable",
      attempt: 2,
    });
  });

  it("does not run or publish an outcome after its debug session is aborted", async () => {
    const deps = passingVerifier();
    const controller = new AbortController();
    controller.abort();

    const command = await runDebugCleanupVerification(
      {
        ...TARGET,
        structuredOutput: CLEANUP_PAYLOAD,
        signal: controller.signal,
      },
      deps,
    );

    expect(command).toBeNull();
    expect(deps.verifyCleanup).not.toHaveBeenCalled();
  });
});
