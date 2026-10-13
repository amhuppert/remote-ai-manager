import { describe, expect, it } from "vitest";
import {
  agentLaunchRequestSchema,
  resolveContextStart,
  type ResolvedSeat,
} from "./launch";
import {
  RUN_SETTING_DEFAULTS,
  requestFieldsOf,
  runSettingsPatchSchema,
  settingPathOf,
} from "./settings";

const sonnet: ResolvedSeat = {
  backend: "claude",
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function start(raw: Record<string, unknown>, reviewers: ResolvedSeat[] = []) {
  const resolved = resolveContextStart({
    request: agentLaunchRequestSchema.parse(raw),
    key: "agent",
    placement: {
      runId: "run-1",
      cause: "launch:run-1",
      projectPath: "/repo",
      session: {
        sessionName: "session",
        worktreePath: "/repo/.worktrees/session",
        branch: "csm/session",
      },
      owner: { conversationId: "owner-1", sessionName: "session" },
      laneTargets: (laneId) => ({
        worktreePath: `/repo/.worktrees/session.${laneId}`,
        branch: `csm/session-${laneId}`,
      }),
      validationCommands: ["typecheck"],
    },
    scope: { mode: "full" },
    seats: { implementer: sonnet, reviewers },
  });
  if (!resolved.ok)
    throw new Error(
      resolved.unregistered.map((issue) => issue.message).join("; "),
    );
  return resolved.request;
}

const custom = {
  tier: "project" as const,
  id: "api-writer",
};

describe("run settings", () => {
  it("are what a launch that names none of them resolves to", () => {
    const resolved = start({ brief: "Fix it" });

    expect(resolved.contract.implementer.profile).toEqual(
      RUN_SETTING_DEFAULTS.implementer.profile,
    );
    expect(resolved.contract.reviewers).toEqual(RUN_SETTING_DEFAULTS.reviewers);
    expect(resolved.contract.checks).toEqual(RUN_SETTING_DEFAULTS.checks);
    expect(resolved.contract.humanApproval).toBe(
      RUN_SETTING_DEFAULTS.humanApproval,
    );
    expect(resolved.contract.ownerQuestions).toBe(
      RUN_SETTING_DEFAULTS.ownerQuestions,
    );
    expect(resolved.policy.invocationTimeoutMs).toBe(
      RUN_SETTING_DEFAULTS.timeoutMs,
    );
  });

  it("written into a launch as request fields, resolve to the same contract as leaving them out", () => {
    expect(
      start({ brief: "Fix it", ...requestFieldsOf(RUN_SETTING_DEFAULTS) }),
    ).toEqual(start({ brief: "Fix it" }));
  });

  it("map each setting a patch sets to its launch fields, and leave the rest out", () => {
    const fields = requestFieldsOf({
      implementer: {
        profile: custom,
        backend: "codex",
        modelSelection: { modelId: "gpt-5.4", parameters: { effort: "high" } },
      },
      reviewers: [
        {
          authority: "blocking",
          focus: "Correctness",
          profile: { tier: "builtin", id: "general-reviewer" },
        },
      ],
      humanApproval: true,
      timeoutMs: 600_000,
    });

    expect(fields).toEqual({
      profile: custom,
      backend: "codex",
      modelSelection: { modelId: "gpt-5.4", parameters: { effort: "high" } },
      reviewers: [
        {
          authority: "blocking",
          focus: "Correctness",
          profile: { tier: "builtin", id: "general-reviewer" },
        },
      ],
      humanApproval: true,
      timeoutMs: 600_000,
    });
    expect(
      agentLaunchRequestSchema.safeParse({ brief: "x", ...fields }).success,
    ).toBe(true);
  });

  it("leave an implementer's backend and model to the configured default when the setting names neither", () => {
    const fields = requestFieldsOf({ implementer: { profile: custom } });

    expect(fields).toEqual({ profile: custom });
  });

  it("set no timeout when a tier sets it to none, so the launch keeps the unlimited default", () => {
    const fields = requestFieldsOf({ timeoutMs: null, ownerQuestions: false });

    expect(fields).toEqual({ ownerQuestions: false });
    expect(
      start({ brief: "x", ...fields }).policy.invocationTimeoutMs,
    ).toBeNull();
  });

  it("refuse an allowance, which deploy 1 could not read back", () => {
    expect(
      runSettingsPatchSchema.safeParse({ validationRetries: 3 }).success,
    ).toBe(false);
  });

  it("locate a launch field's issue at the setting it came from", () => {
    expect(settingPathOf(["modelSelection", "modelId"])).toEqual({
      key: "implementer",
      path: ["implementer", "modelSelection", "modelId"],
    });
    expect(settingPathOf(["profile"])).toEqual({
      key: "implementer",
      path: ["implementer", "profile"],
    });
    expect(settingPathOf(["reviewers", 1, "profile", "id"])).toEqual({
      key: "reviewers",
      path: ["reviewers", 1, "profile", "id"],
    });
    expect(settingPathOf(["checks", 0])).toEqual({
      key: "checks",
      path: ["checks", 0],
    });
    expect(settingPathOf(["brief"])).toBeNull();
    expect(settingPathOf([])).toBeNull();
  });
});
