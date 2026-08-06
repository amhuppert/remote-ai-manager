import { describe, expect, it } from "vitest";
import type { FsWritePolicy } from "../task";
import { buildCodexFsWriteEnvelope } from "./fs-write-envelope";

const SCRATCH = "/private/tmp/cc-validator-lanes/exec/ctx/reviewer";
const LANE_TMP = `${SCRATCH}/tmp`;
const WORKTREE = "/private/volumes/repo/worktree";

function policy(overrides?: Partial<FsWritePolicy>): FsWritePolicy {
  return {
    mode: "allowlist",
    allowWrite: [SCRATCH, LANE_TMP],
    denyWrite: [WORKTREE],
    ...overrides,
  };
}

function envelopeOf(input: FsWritePolicy) {
  const result = buildCodexFsWriteEnvelope(input);
  if (result.kind !== "envelope") {
    throw new Error(`expected an envelope, got: ${result.reason}`);
  }
  return result.envelope;
}

describe("buildCodexFsWriteEnvelope", () => {
  it("relocates the run into the lane's own writable root and points TMPDIR at the lane temp", () => {
    const envelope = envelopeOf(policy());

    // The worktree can never be the cwd of a workspace-write run: workspace-write
    // makes the working directory writable by construction.
    expect(envelope.workingDirectory).toBe(SCRATCH);
    expect(envelope.workingDirectory).not.toBe(WORKTREE);
    expect(envelope.tmpDir).toBe(LANE_TMP);
  });

  it("pins the writable roots to exactly the policy allowlist", () => {
    const config = envelopeOf(policy()).config;
    const workspaceWrite = config.sandbox_workspace_write;

    expect(workspaceWrite).toMatchObject({
      writable_roots: [SCRATCH, LANE_TMP],
    });
  });

  it("excludes the ambient temp directories the sandbox would otherwise add", () => {
    // workspace-write adds $TMPDIR and /tmp to the writable set by default.
    // Inherited ambient temp is not the lane's temp, so it is excluded and only
    // the explicit roots remain.
    expect(envelopeOf(policy()).config.sandbox_workspace_write).toMatchObject({
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
  });

  it("pins the sandbox mode in config so an inherited user config cannot widen it", () => {
    expect(envelopeOf(policy()).config).toMatchObject({
      sandbox_mode: "workspace-write",
      approval_policy: "never",
    });
  });

  it("neutralizes the ambient instruction and memory surfaces the user config carries", () => {
    const config = envelopeOf(policy()).config;

    expect(config).toMatchObject({
      project_doc_fallback_filenames: [],
      project_doc_max_bytes: 0,
      include_apps_instructions: false,
      apps: { _default: { enabled: false } },
      memories: {
        dedicated_tools: false,
        generate_memories: false,
        use_memories: false,
      },
      skills: { bundled: { enabled: false }, include_instructions: false },
    });
  });

  it("never lists a denied path as a writable root", () => {
    const config = envelopeOf(policy()).config;
    const workspaceWrite = config.sandbox_workspace_write as {
      writable_roots: string[];
    };

    expect(workspaceWrite.writable_roots).not.toContain(WORKTREE);
  });

  describe("fail-closed establishment", () => {
    it("refuses an empty allowlist rather than falling back to a writable cwd", () => {
      const result = buildCodexFsWriteEnvelope(policy({ allowWrite: [] }));

      expect(result.kind).toBe("unestablishable");
    });

    it("refuses a relative allowlist entry, which the sandbox would resolve against an unknown cwd", () => {
      const result = buildCodexFsWriteEnvelope(
        policy({ allowWrite: ["scratch", LANE_TMP] }),
      );

      expect(result.kind).toBe("unestablishable");
    });

    it("refuses an allowlist entry inside a denied path", () => {
      // A policy that both permits and forbids the same subtree is not a policy
      // the backend can enforce as written, and guessing which half to honor is
      // exactly the guess this envelope exists to eliminate.
      const result = buildCodexFsWriteEnvelope(
        policy({ allowWrite: [`${WORKTREE}/reports`, LANE_TMP] }),
      );

      expect(result.kind).toBe("unestablishable");
    });

    it("refuses an allowlist entry equal to a denied path", () => {
      const result = buildCodexFsWriteEnvelope(
        policy({ allowWrite: [WORKTREE], denyWrite: [WORKTREE] }),
      );

      expect(result.kind).toBe("unestablishable");
    });
  });
});
