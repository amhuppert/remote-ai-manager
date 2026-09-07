import { type VerifyCleanupInput } from "@/lib/workflows/debug/cleanup-verification";
/**
 * Tests for the async debug cleanup-verification runner: payload parsing
 * (including the schema-failure fallback), outcome → DebugCommand mapping,
 * and error containment (a thrown verifier must surface as a
 * cleanup_verification_failed command, never a rejection).
 */
import { describe, expect, it, vi } from "vitest";
import { runDebugCleanupVerification } from "./cleanup-verification";

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

it("retains the real manifest on refusal or cancellation and deletes it only after verified cleanup", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { getDebugManifestPath, verifyCleanupAgainstManifest, deleteManifest } =
    await import("@/lib/debug-log/service");
  const { verifyDebugCleanup } = await import("./cleanup-verification");
  const worktreePath = await fs.mkdtemp(
    path.join(process.cwd(), ".cc/temp/debug-cleanup-"),
  );
  const manifestPath = getDebugManifestPath(worktreePath, "owned-cleanup");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = JSON.stringify({
    conversationId: "owned-cleanup",
    createdAt: new Date(0).toISOString(),
    probes: [
      { id: "H1:probe", file: "src/a.ts", description: "Decision input" },
    ],
  });
  await fs.writeFile(manifestPath, manifest);
  const input = {
    worktreePath,
    conversationId: "owned-cleanup",
    cleanup: CLEANUP_PAYLOAD,
  };
  try {
    expect(
      await verifyDebugCleanup({
        ...input,
        cleanup: { ...CLEANUP_PAYLOAD, filesModified: [] },
      }),
    ).toMatchObject({ ok: false, missingFiles: ["src/a.ts"] });
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifest);
    let release!: () => void;
    const read = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    const controller = new AbortController();
    const verification = verifyDebugCleanup(input, controller.signal, {
      async verifyCleanupAgainstManifest(...args) {
        reading = true;
        await read;
        return verifyCleanupAgainstManifest(...args);
      },
      deleteManifest,
    });
    await vi.waitFor(() => expect(reading).toBe(true));
    controller.abort();
    release();
    await expect(verification).rejects.toThrow("Cleanup verification aborted");
    expect(await fs.readFile(manifestPath, "utf8")).toBe(manifest);
    expect(await verifyDebugCleanup(input)).toMatchObject({ ok: true });
    await expect(fs.access(manifestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
});
