/**
 * Claude's half of the native-memory neutralization declared by
 * `claudeNativeMemory` in `./descriptor.ts`.
 *
 * Auto-memory is a store the CLI reads and writes on its own, outside anything
 * Command Center composes — so leaving it on would put a second, invisible
 * memory system in the same turn as the CC library. The Agent SDK exposes the
 * switch on the `Settings` layer, which is the right layer for CC to use: it
 * travels with the launch and outranks whatever the machine's
 * `~/.claude/settings.json` says, unlike an env var or a CLI flag we would have
 * to keep re-asserting. It does NOT outrank managed policy, which is why the
 * launch guard below exists.
 *
 * `autoDreamEnabled` is the background consolidation pass over that same store.
 * Disabling reads and writes but leaving consolidation on would keep a writer
 * running against a store nothing reads.
 *
 * Applied to CONVERSATIONS and TASK RUNS alike — every environment CC launches,
 * which is the scope the declaration claims.
 */

import {
  resolveSettings,
  type PolicySettingsOrigin,
  type ResolvedSettings,
  type ResolveSettingsOptions,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_NATIVE_MEMORY_SETTINGS: Readonly<
  Pick<Settings, "autoMemoryEnabled" | "autoDreamEnabled">
> = {
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
};

/**
 * Why the settings above are not, on their own, enough.
 *
 * `Options.settings` is the SDK's FLAG tier. The installed SDK documents it as
 * sitting above user/project/local settings and below the managed policy tier
 * (managed-settings.json, the remote-cached org payload, and MDM via plist or
 * the Windows registry). There is no tier above managed policy — that is the
 * point of managed policy — so on a host whose administrator asserts
 * `autoMemoryEnabled: true`, everything CC passes loses and the launched
 * environment reads and writes a memory store CC never sees.
 *
 * The descriptor's claim is unconditional, so the launch has to be too: CC
 * resolves the policy tier before every Claude launch and refuses when it
 * cannot come out false. Refusing is the only honest option left, since there
 * is no lever to pull and a launch that proceeded would make the declaration
 * and both disclosure surfaces lie.
 *
 * The resolver is NOT fully faithful to CLI startup, and the divergences are
 * not all documented in one place: `policyHelper` is named in the resolver's
 * own remarks, while `forceRemoteSettingsRefresh` is described only on its own
 * declaration. Do not hand-survey this surface — three rounds of doing so
 * missed a key each time. `native-memory-policy-surface.test.ts` scans the
 * installed declaration file and fails on any startup-scoped policy key that
 * has not been triaged, and every key triaged unverifiable is refused by the
 * probe table below.
 *
 * `permissions.defaultMode` is reported without the CLI's trust filter, but
 * that concerns permission modes rather than the memory keys, so it does not
 * bear on this guard.
 */

/** The keys whose effective value the launch depends on. */
const NEUTRALIZED_SETTINGS = Object.keys(
  CLAUDE_NATIVE_MEMORY_SETTINGS,
) as ReadonlyArray<keyof typeof CLAUDE_NATIVE_MEMORY_SETTINGS>;

export interface ClaudeNativeMemoryPolicyOverride {
  readonly setting: keyof typeof CLAUDE_NATIVE_MEMORY_SETTINGS;
  /** Which policy sub-source supplied it, when the cascade reported one. */
  readonly policyOrigin: PolicySettingsOrigin | null;
}

/**
 * A policy source present in the cascade whose CONTENT Command Center cannot
 * read — the category that has to be refused rather than assumed harmless.
 *
 * This is a table rather than a field per key on purpose. Each of these was
 * found one at a time, and the shape that finds them one at a time is the
 * shape that keeps missing the next one; adding a fourth is now a row here plus
 * a row in the pinned SDK-surface triage (see `native-memory-policy-surface.test.ts`).
 */
export type ClaudeUnverifiablePolicySetting =
  | "policyHelper"
  | "forceRemoteSettingsRefresh";

export interface ClaudeUnverifiablePolicySource {
  readonly setting: ClaudeUnverifiablePolicySetting;
  /** Identifying detail for the operator, when the key carries one. */
  readonly detail: string | null;
}

interface UnverifiablePolicyProbe {
  readonly setting: ClaudeUnverifiablePolicySetting;
  /** The identifying detail when present, `undefined` when the key is absent or inert. */
  readonly detect: (settings: Settings) => string | null | undefined;
  /** Operator-facing prose: what CC cannot see, and what to do about it. */
  readonly explain: (detail: string | null) => string;
}

/**
 * Every managed setting that makes the policy the CLI applies at startup differ
 * from the policy `resolveSettings` reports.
 *
 * Both entries are documented divergences, not speculation:
 *  - `policyHelper` is "an executable that computes managed settings at
 *    startup", and the resolver explicitly does not execute it.
 *  - `forceRemoteSettingsRefresh` makes the CLI "block startup until remote
 *    managed settings are freshly fetched", while the resolver reads the
 *    CACHED remote payload — so the fetch can introduce an override the cache
 *    never had.
 *
 * In both cases the key's PRESENCE is visible (it is honoured only from admin
 * policy sources, so it lands in the tier CC inspects) while its EFFECT is not.
 */
const UNVERIFIABLE_POLICY_PROBES: readonly UnverifiablePolicyProbe[] = [
  {
    setting: "policyHelper",
    detect: (settings) => settings.policyHelper?.path,
    explain: (detail) =>
      `managed policy configures the startup policy helper ${detail}, whose injected settings Command Center cannot read (the settings resolver does not execute it, but Claude does at startup). Its output outranks everything Command Center passes and could re-enable native memory. Remove the policyHelper from the managed settings tier, or confirm it never sets autoMemoryEnabled or autoDreamEnabled and clear it there.`,
  },
  {
    setting: "forceRemoteSettingsRefresh",
    detect: (settings) =>
      settings.forceRemoteSettingsRefresh === true ? null : undefined,
    explain: () =>
      `managed policy sets forceRemoteSettingsRefresh, so Claude blocks startup to fetch remote managed settings that Command Center has not seen — the cascade inspected here is the CACHED payload, and the fresh one can carry a memory override it does not. Clear forceRemoteSettingsRefresh from the managed settings tier, or confirm the served policy never sets autoMemoryEnabled or autoDreamEnabled.`,
  },
];

/**
 * What the resolved policy tier says about the neutralization — total, so a
 * caller cannot check one refusal cause and forget the other.
 *
 * `refused` carries every cause rather than the first found: clearing only the
 * one named in a message would leave the launch still refused, which is a worse
 * experience than being told everything at once.
 */
export type ClaudeNativeMemoryPolicyVerdict =
  | { readonly outcome: "neutralized" }
  | {
      readonly outcome: "refused";
      readonly overrides: readonly ClaudeNativeMemoryPolicyOverride[];
      readonly unverifiableSources: readonly ClaudeUnverifiablePolicySource[];
    };

/**
 * Refusal to launch Claude because native memory could not be proven off.
 *
 * The causes are carried separately so an operator can tell them apart: a
 * policy decision (`overrides`), a policy source whose content CC cannot read
 * (`unverifiableSources`), or a cascade that could not be read at all (both
 * empty, with the underlying message). All refuse, because none of them can
 * honour the descriptor's unconditional claim.
 */
export class ClaudeNativeMemoryPolicyConflictError extends Error {
  readonly overrides: readonly ClaudeNativeMemoryPolicyOverride[];
  readonly unverifiableSources: readonly ClaudeUnverifiablePolicySource[];

  constructor(
    message: string,
    cause: {
      overrides?: readonly ClaudeNativeMemoryPolicyOverride[];
      unverifiableSources?: readonly ClaudeUnverifiablePolicySource[];
    } = {},
  ) {
    super(message);
    this.name = "ClaudeNativeMemoryPolicyConflictError";
    this.overrides = cause.overrides ?? [];
    this.unverifiableSources = cause.unverifiableSources ?? [];
  }
}

/**
 * Judge a cascade resolved WITHOUT the filesystem sources (`settingSources:
 * []`), so everything left in `effective` is a policy-tier value — which is
 * exactly the set that outranks the flag layer CC writes.
 *
 * Two things force a refusal: a neutralized key the policy tier sets back to
 * `true` (absent or already `false` is not an override — the policy tier simply
 * agrees), and any probe in `UNVERIFIABLE_POLICY_PROBES`. Unverifiable is not
 * the same as off.
 */
export function assessClaudeNativeMemoryPolicy(
  resolved: Pick<ResolvedSettings, "effective" | "provenance">,
): ClaudeNativeMemoryPolicyVerdict {
  const overrides = NEUTRALIZED_SETTINGS.flatMap((setting) =>
    resolved.effective[setting] === true
      ? [
          {
            setting,
            policyOrigin: resolved.provenance[setting]?.policyOrigin ?? null,
          },
        ]
      : [],
  );

  const unverifiableSources = UNVERIFIABLE_POLICY_PROBES.flatMap((probe) => {
    const detail = probe.detect(resolved.effective);
    return detail === undefined ? [] : [{ setting: probe.setting, detail }];
  });

  return overrides.length === 0 && unverifiableSources.length === 0
    ? { outcome: "neutralized" }
    : { outcome: "refused", overrides, unverifiableSources };
}

type ClaudeSettingsResolver = (
  opts: ResolveSettingsOptions,
) => Promise<ResolvedSettings>;

const defaultSettingsResolver: ClaudeSettingsResolver = (opts) =>
  resolveSettings(opts);

let settingsResolverImpl: ClaudeSettingsResolver = defaultSettingsResolver;

/**
 * Test-only seam, mirroring `_setSdkQueryForTesting`: replaces the SDK's
 * settings merge engine so a suite can drive a launch against a conflicting
 * managed policy — and so no unit test reads the host's real MDM policy, which
 * would make the launch paths pass or fail by machine. Pass null to restore.
 */
export function _setClaudeSettingsResolverForTesting(
  impl: ClaudeSettingsResolver | null,
): void {
  settingsResolverImpl = impl ?? defaultSettingsResolver;
}

/**
 * Guard every CC-launched Claude environment: resolve the policy tier for the
 * launch directory and throw unless native memory comes out provably off.
 *
 * Production goes through the SDK's own merge engine, so the answer matches
 * what the CLI would compute at startup rather than a reimplementation of it —
 * with the one documented exception the verdict treats as a refusal, the
 * `policyHelper` subprocess the resolver does not execute.
 */
export async function assertClaudeNativeMemoryNeutralized(args: {
  cwd: string;
}): Promise<void> {
  let resolved: ResolvedSettings;
  try {
    resolved = await settingsResolverImpl({
      cwd: args.cwd,
      settingSources: [],
    });
  } catch (err) {
    throw new ClaudeNativeMemoryPolicyConflictError(
      `Refusing to launch Claude: Command Center could not resolve the managed settings policy tier to confirm native auto-memory is disabled (${err instanceof Error ? err.message : String(err)}).`,
    );
  }

  const verdict = assessClaudeNativeMemoryPolicy(resolved);
  if (verdict.outcome === "neutralized") return;

  const causes: string[] = [];
  if (verdict.overrides.length > 0) {
    const named = verdict.overrides
      .map(
        (override) =>
          `${override.setting} (policy origin: ${override.policyOrigin ?? "unknown"})`,
      )
      .join(", ");
    causes.push(
      `managed policy settings force native memory back on — ${named}. Managed policy outranks the settings Command Center passes, so this environment would run Claude's memory store alongside the Command Center library. Clear these keys from the managed settings tier to launch.`,
    );
  }
  for (const source of verdict.unverifiableSources) {
    const probe = UNVERIFIABLE_POLICY_PROBES.find(
      (candidate) => candidate.setting === source.setting,
    );
    causes.push(probe?.explain(source.detail) ?? source.setting);
  }

  throw new ClaudeNativeMemoryPolicyConflictError(
    `Refusing to launch Claude: ${causes.join(" Also, ")}`,
    {
      overrides: verdict.overrides,
      unverifiableSources: verdict.unverifiableSources,
    },
  );
}
