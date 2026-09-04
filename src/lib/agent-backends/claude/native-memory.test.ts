/**
 * Claude's native-memory neutralization is a claim about the EFFECTIVE
 * settings cascade, not about the payload Command Center hands the SDK.
 *
 * `Options.settings` is the flag tier, which the installed SDK documents as
 * sitting above user/project/local settings and BELOW the managed policy tier.
 * A host whose managed policy asserts `autoMemoryEnabled: true` therefore wins
 * over everything CC passes, and no lever exists above it — so the only way to
 * keep the descriptor's `disabled` claim true is to detect the conflict and
 * refuse to launch.
 *
 * The cascade is resolved WITHOUT running the admin-configured `policyHelper`
 * subprocess, which the real CLI DOES run at startup. Its injected settings are
 * therefore invisible here and could turn either key back on, so a declared
 * helper is itself a refusal: unverifiable is not the same as off. These tests
 * pin both decisions.
 */

import { afterEach, describe, expect, it } from "vitest";
import type {
  ResolvedSettings,
  ResolveSettingsOptions,
} from "@anthropic-ai/claude-agent-sdk";

import {
  _setClaudeSettingsResolverForTesting,
  assertClaudeNativeMemoryNeutralized,
  assessClaudeNativeMemoryPolicy,
  ClaudeNativeMemoryPolicyConflictError,
} from "./native-memory";

afterEach(() => {
  _setClaudeSettingsResolverForTesting(null);
});

/** A cascade resolved with `settingSources: []` — the managed tier alone. */
function managedTierOnly(
  settings: ResolvedSettings["effective"],
  policyOrigin: "remote" | "plist" | "file" = "file",
): ResolvedSettings {
  return {
    effective: settings,
    provenance: Object.fromEntries(
      Object.keys(settings).map((key) => [
        key,
        { source: "managed", policyOrigin },
      ]),
    ) as ResolvedSettings["provenance"],
    sources:
      Object.keys(settings).length > 0
        ? [{ source: "managed", settings, policyOrigin }]
        : [],
  };
}

describe("assessClaudeNativeMemoryPolicy", () => {
  it("clears the launch when the policy tier is silent", () => {
    expect(assessClaudeNativeMemoryPolicy(managedTierOnly({}))).toEqual({
      outcome: "neutralized",
    });
  });

  it("clears the launch when the policy tier agrees the memory is off", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({ autoMemoryEnabled: false, autoDreamEnabled: false }),
      ),
    ).toEqual({ outcome: "neutralized" });
  });

  it("refuses when auto-memory is forced on, naming its policy origin", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({ autoMemoryEnabled: true }, "remote"),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [{ setting: "autoMemoryEnabled", policyOrigin: "remote" }],
      unverifiableSources: [],
    });
  });

  it("refuses on the background consolidation pass independently", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({ autoMemoryEnabled: false, autoDreamEnabled: true }),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [{ setting: "autoDreamEnabled", policyOrigin: "file" }],
      unverifiableSources: [],
    });
  });

  it("ignores unrelated policy settings", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({ model: "opus", cleanupPeriodDays: 30 }),
      ),
    ).toEqual({ outcome: "neutralized" });
  });

  it("refuses on a declared policy helper even when every visible value is off", () => {
    // `resolveSettings` does not execute the helper, but the real CLI does at
    // startup — and the helper is honoured only from admin policy sources, so
    // whatever it injects outranks the flag layer. Its output could set either
    // key and this cascade would never show it.
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({
          autoMemoryEnabled: false,
          autoDreamEnabled: false,
          policyHelper: { path: "/opt/corp/policy-helper", timeoutMs: 5000 },
        }),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [],
      unverifiableSources: [
        { setting: "policyHelper", detail: "/opt/corp/policy-helper" },
      ],
    });
  });

  it("refuses on a forced remote settings refresh even when every visible value is off", () => {
    // The cascade reads the CACHED remote policy. This key makes the launched
    // CLI block startup for a FRESH fetch, whose payload can carry a memory
    // override the cache never had — so what CC inspected is not what the CLI
    // will apply.
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({
          autoMemoryEnabled: false,
          autoDreamEnabled: false,
          forceRemoteSettingsRefresh: true,
        }),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [],
      unverifiableSources: [
        { setting: "forceRemoteSettingsRefresh", detail: null },
      ],
    });
  });

  it("clears the launch when the refresh key is present but off", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({ forceRemoteSettingsRefresh: false }),
      ),
    ).toEqual({ outcome: "neutralized" });
  });

  it("reports every unverifiable source at once, not just the first", () => {
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({
          policyHelper: { path: "/opt/corp/policy-helper" },
          forceRemoteSettingsRefresh: true,
        }),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [],
      unverifiableSources: [
        { setting: "policyHelper", detail: "/opt/corp/policy-helper" },
        { setting: "forceRemoteSettingsRefresh", detail: null },
      ],
    });
  });

  it("reports a forced value and an unverifiable helper together", () => {
    // Both are refusal causes; neither hides the other, because clearing only
    // the one named in the message would leave the launch still refused.
    expect(
      assessClaudeNativeMemoryPolicy(
        managedTierOnly({
          autoMemoryEnabled: true,
          policyHelper: { path: "/opt/corp/policy-helper" },
        }),
      ),
    ).toEqual({
      outcome: "refused",
      overrides: [{ setting: "autoMemoryEnabled", policyOrigin: "file" }],
      unverifiableSources: [
        { setting: "policyHelper", detail: "/opt/corp/policy-helper" },
      ],
    });
  });
});

describe("assertClaudeNativeMemoryNeutralized", () => {
  it("resolves the policy tier alone for the launch directory", async () => {
    const seen: ResolveSettingsOptions[] = [];
    _setClaudeSettingsResolverForTesting(async (opts) => {
      seen.push(opts);
      return managedTierOnly({});
    });

    await assertClaudeNativeMemoryNeutralized({
      cwd: "/project/.worktrees/sess",
    });

    // `settingSources: []` is what makes the answer meaningful: user, project,
    // and local settings sit BELOW the flag layer CC writes, so only the
    // managed tier can beat it.
    expect(seen).toEqual([
      { cwd: "/project/.worktrees/sess", settingSources: [] },
    ]);
  });

  it("passes when nothing outranks the flag layer", async () => {
    _setClaudeSettingsResolverForTesting(async () =>
      managedTierOnly({ autoMemoryEnabled: false }),
    );
    await expect(
      assertClaudeNativeMemoryNeutralized({ cwd: "/w" }),
    ).resolves.toBeUndefined();
  });

  it("refuses the launch when managed policy forces auto-memory on", async () => {
    _setClaudeSettingsResolverForTesting(async () =>
      managedTierOnly({ autoMemoryEnabled: true }, "plist"),
    );
    const error = await assertClaudeNativeMemoryNeutralized({
      cwd: "/w",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClaudeNativeMemoryPolicyConflictError);
    const conflict = error as ClaudeNativeMemoryPolicyConflictError;
    expect(conflict.overrides).toEqual([
      { setting: "autoMemoryEnabled", policyOrigin: "plist" },
    ]);
    // The operator has to be told which knob, at which tier, to be able to act.
    expect(conflict.message).toContain("autoMemoryEnabled");
    expect(conflict.message).toContain("plist");
  });

  it("refuses the launch when an unverifiable policy helper is configured", async () => {
    _setClaudeSettingsResolverForTesting(async () =>
      managedTierOnly({
        autoMemoryEnabled: false,
        autoDreamEnabled: false,
        policyHelper: { path: "/opt/corp/policy-helper" },
      }),
    );
    const error = await assertClaudeNativeMemoryNeutralized({
      cwd: "/w",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClaudeNativeMemoryPolicyConflictError);
    const conflict = error as ClaudeNativeMemoryPolicyConflictError;
    expect(conflict.unverifiableSources).toEqual([
      { setting: "policyHelper", detail: "/opt/corp/policy-helper" },
    ]);
    expect(conflict.overrides).toEqual([]);
    // Name the helper so the operator knows which executable to look at.
    expect(conflict.message).toContain("/opt/corp/policy-helper");
  });

  it("refuses the launch when a forced remote settings refresh is configured", async () => {
    _setClaudeSettingsResolverForTesting(async () =>
      managedTierOnly({
        autoMemoryEnabled: false,
        autoDreamEnabled: false,
        forceRemoteSettingsRefresh: true,
      }),
    );
    const error = await assertClaudeNativeMemoryNeutralized({
      cwd: "/w",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClaudeNativeMemoryPolicyConflictError);
    const conflict = error as ClaudeNativeMemoryPolicyConflictError;
    expect(conflict.unverifiableSources).toEqual([
      { setting: "forceRemoteSettingsRefresh", detail: null },
    ]);
    expect(conflict.message).toContain("forceRemoteSettingsRefresh");
  });

  it("refuses the launch when the cascade cannot be resolved at all", async () => {
    // An unverifiable launch cannot honour an unconditional `disabled` claim,
    // so an unreadable cascade is a refusal rather than a silent pass.
    _setClaudeSettingsResolverForTesting(async () => {
      throw new Error("managed-settings.json is not valid JSON");
    });
    const error = await assertClaudeNativeMemoryNeutralized({
      cwd: "/w",
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClaudeNativeMemoryPolicyConflictError);
    expect((error as Error).message).toContain("managed-settings.json");
  });
});
