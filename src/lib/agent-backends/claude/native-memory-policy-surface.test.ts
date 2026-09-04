/**
 * A ratchet over the INSTALLED SDK's managed-settings surface.
 *
 * Three validation rounds were spent finding, one at a time, managed settings
 * that make the policy Claude applies at startup differ from the policy
 * `resolveSettings` reports. Hand-surveying the SDK found each one only after
 * it was missed, so this test replaces the survey: it scans the vendored
 * declaration file for every setting whose documentation ties it to managed
 * policy AND to startup, and fails unless each one has been triaged here.
 *
 * When an SDK bump adds a fourth such key, this reds with the key's name
 * instead of quietly widening the gap. A red here is not a flake — it is the
 * signal to read that key's documentation and decide whether the launch guard
 * can still prove native memory is off.
 *
 * Reading `node_modules` from a test is deliberate: the claim being defended is
 * about the SDK actually installed, not about a copy of its docs that could
 * drift.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { assessClaudeNativeMemoryPolicy } from "./native-memory";

/**
 * Every scanned key, and what CC concluded about it.
 *
 * `unverifiable` — the key changes what policy the CLI reads at startup, and
 * its effect is invisible to the resolver, so its presence refuses the launch.
 * `benign` — the key is admin-controlled and startup-scoped but cannot change
 * the effective value of the auto-memory settings.
 */
const TRIAGED_STARTUP_POLICY_KEYS: Record<string, "unverifiable" | "benign"> = {
  // "Executable that computes managed settings at startup." The resolver
  // documents that it does not execute it.
  policyHelper: "unverifiable",
  // "Blocks startup until remote managed settings are freshly fetched." The
  // resolver reads the cached remote payload, not the fresh one.
  forceRemoteSettingsRefresh: "unverifiable",
  // Rejects certain CLI flags at startup. It restricts what the launcher may
  // pass; it does not add or change a policy source.
  disableSideloadFlags: "benign",
};

function scanStartupPolicyKeys(): string[] {
  // The package's exports map does not expose the declaration file directly, so
  // locate it beside the resolved runtime entry.
  const require = createRequire(import.meta.url);
  const declarationPath = join(
    dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
    "sdk.d.ts",
  );
  const source = readFileSync(declarationPath, "utf8");

  const documentedProperty =
    /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*\n\s*(\w+)\?:/g;
  const found = new Set<string>();
  for (const match of source.matchAll(documentedProperty)) {
    const [, doc, property] = match;
    if (doc === undefined || property === undefined) continue;
    // A doc block that runs into a declaration is a comment for that
    // declaration, not for a settings property.
    if (/export declare|interface /.test(doc)) continue;
    const text = doc.replace(/\s*\*\s?/g, " ");
    if (!/managed settings|policy settings|policy source/i.test(text)) continue;
    if (!/startup|freshly fetched/i.test(text)) continue;
    found.add(property);
  }
  return [...found].sort();
}

describe("Claude managed-settings startup surface", () => {
  it("finds the surface at all, so a silent zero cannot pass as agreement", () => {
    // Without this, a scanner broken by an SDK reformat would return an empty
    // set and the equality check below would still pass.
    expect(scanStartupPolicyKeys().length).toBeGreaterThan(0);
  });

  it("has a triage decision recorded for every startup-scoped policy key", () => {
    expect(scanStartupPolicyKeys()).toEqual(
      Object.keys(TRIAGED_STARTUP_POLICY_KEYS).sort(),
    );
  });

  it("refuses a launch for every key triaged unverifiable", () => {
    // Ties the registry above to real behaviour: marking a key `unverifiable`
    // without teaching the guard to refuse it fails here.
    const unverifiable = Object.entries(TRIAGED_STARTUP_POLICY_KEYS)
      .filter(([, disposition]) => disposition === "unverifiable")
      .map(([key]) => key);

    // The value each key takes when an administrator has actually enabled it.
    const enabledValue: Record<string, unknown> = {
      policyHelper: { path: "/opt/corp/policy-helper" },
      forceRemoteSettingsRefresh: true,
    };

    for (const key of unverifiable) {
      const verdict = assessClaudeNativeMemoryPolicy({
        effective: {
          autoMemoryEnabled: false,
          autoDreamEnabled: false,
          [key]: enabledValue[key],
        },
        provenance: {},
      });
      expect(verdict, `${key} must refuse the launch`).toMatchObject({
        outcome: "refused",
        unverifiableSources: [{ setting: key }],
      });
    }
  });
});
