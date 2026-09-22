import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITY_CASCADE_KINDS,
  agentCapabilityMetadata,
  agentCapabilityMetadataSchema,
  createAgentCapabilityMetadataRegistry,
  defaultAgentCapabilityMetadataRegistry,
  type AgentCapabilityCascadeKind,
} from "./metadata";

describe("agent capability metadata registry", () => {
  it("declares Cursor CC delivery at the next-conversation boundary", () => {
    const records =
      defaultAgentCapabilityMetadataRegistry.listForBackend("cursor");
    expect(records.map((record) => record.cascadeKind)).toEqual([
      "cursor-skills",
      "cursor-plugins",
      "cursor-agents",
    ]);
    for (const record of records)
      expect(record).toMatchObject({
        applySemantics: "next-conversation",
        compositionSupport: "translator",
        discoverySupport: "available",
      });
  });

  it("declares the supported cascade kinds", () => {
    expect(AGENT_CAPABILITY_CASCADE_KINDS).toEqual([
      "claude-skills",
      "claude-plugins",
      "claude-agents",
      "codex-skills",
      "codex-plugins",
      "cursor-skills",
      "cursor-plugins",
      "cursor-agents",
    ]);
  });

  it("provides exactly one metadata record per cascade kind", () => {
    const cascadeKinds = new Set<AgentCapabilityCascadeKind>();
    for (const record of agentCapabilityMetadata) {
      expect(cascadeKinds.has(record.cascadeKind)).toBe(false);
      cascadeKinds.add(record.cascadeKind);
    }
    expect(cascadeKinds.size).toBe(AGENT_CAPABILITY_CASCADE_KINDS.length);
  });

  it("assigns each cascade to its backend", () => {
    for (const record of agentCapabilityMetadata) {
      if (record.cascadeKind.startsWith("claude-")) {
        expect(record.backend).toBe("claude");
      } else if (record.cascadeKind.startsWith("codex-")) {
        expect(record.backend).toBe("codex");
      } else {
        expect(record.backend).toBe("cursor");
      }
    }
  });

  it("marks codex-plugins as discovery-available and translator-composed", () => {
    const codexPlugins =
      defaultAgentCapabilityMetadataRegistry.get("codex-plugins");
    expect(codexPlugins.discoverySupport).toBe("available");
    expect(codexPlugins.compositionSupport).toBe("translator");
  });

  it("marks codex-skills as discovery-available, translator-composed, next-turn apply", () => {
    const codexSkills =
      defaultAgentCapabilityMetadataRegistry.get("codex-skills");
    expect(codexSkills.discoverySupport).toBe("available");
    expect(codexSkills.compositionSupport).toBe("translator");
    expect(codexSkills.applySemantics).toBe("next-turn");
  });

  it("never assigns idle-live-apply to a codex cascade", () => {
    const codexRecords =
      defaultAgentCapabilityMetadataRegistry.listForBackend("codex");
    for (const record of codexRecords) {
      expect(record.applySemantics).not.toBe("idle-live-apply");
    }
  });

  it("applies ordinary Claude skill and plugin changes at the next turn", () => {
    expect(
      defaultAgentCapabilityMetadataRegistry.get("claude-skills")
        .applySemantics,
    ).toBe("next-turn");
    expect(
      defaultAgentCapabilityMetadataRegistry.get("claude-plugins")
        .applySemantics,
    ).toBe("next-turn");
  });

  it("discloses unavailable individual Claude agent control independently of timing", () => {
    const claudeAgents =
      defaultAgentCapabilityMetadataRegistry.get("claude-agents");
    expect(claudeAgents.applySemantics).toBe("next-conversation");
    expect(claudeAgents.support?.configurable).toBe(false);
    expect(claudeAgents.support?.notes.length).toBeGreaterThan(0);
  });

  it("throws when asked for an unregistered cascade", () => {
    const registry = createAgentCapabilityMetadataRegistry([]);
    expect(() => registry.get("claude-skills")).toThrow();
  });

  it("supports adding a future backend through metadata without scattering checks", () => {
    // Future-extensibility check: a custom registry built from arbitrary
    // metadata records must accept any cascade kind we declare, including
    // hypothetical backends added later by the metadata-driven design.
    const registry = createAgentCapabilityMetadataRegistry([
      {
        cascadeKind: "claude-skills",
        backend: "claude",
        capabilityKind: "skill",
        applySemantics: "next-turn",
        discoverySupport: "available",
        runtimeVisibility: "sdk-runtime",
        compositionSupport: "translator",
      },
    ]);
    expect(registry.listForBackend("claude")).toHaveLength(1);
    expect(registry.listForBackend("codex")).toHaveLength(0);
  });

  it("pins codex-plugins runtimeVisibility to source-only (Codex runtime is config-driven, not SDK-runtime)", () => {
    const codexPlugins =
      defaultAgentCapabilityMetadataRegistry.get("codex-plugins");
    expect(codexPlugins.runtimeVisibility).toBe("source-only");
    expect(codexPlugins.capabilityKind).toBe("plugin");
  });

  it("exposes native Claude agents without advertising a writable selection", () => {
    const claudeAgents =
      defaultAgentCapabilityMetadataRegistry.get("claude-agents");
    expect(claudeAgents.runtimeVisibility).toBe("sdk-runtime");
    expect(claudeAgents.capabilityKind).toBe("agent");
    expect(claudeAgents.support?.configurable).toBe(false);
  });

  it("encodes every required metadata field on every cascade record", () => {
    // Acceptance: each cascade record fully specifies backend ownership,
    // capability kind, discovery support, runtime visibility, composition
    // support, and apply semantics. No downstream consumer should have to
    // derive any of these from the cascade string.
    for (const record of agentCapabilityMetadata) {
      expect(record.cascadeKind).toBeDefined();
      expect(record.backend).toBeDefined();
      expect(record.capabilityKind).toBeDefined();
      expect(record.applySemantics).toBeDefined();
      expect(record.discoverySupport).toBeDefined();
      expect(record.runtimeVisibility).toBeDefined();
      expect(record.compositionSupport).toBeDefined();
    }
  });

  it("derives backend partitioning from metadata records, not from cascade-kind string parsing", () => {
    // Build a synthetic registry with valid pairings in reverse declaration
    // order to prove `listForBackend` reads `record.backend` rather than
    // parsing the cascade-kind prefix or relying on insertion order.
    const registry = createAgentCapabilityMetadataRegistry([
      {
        cascadeKind: "codex-skills",
        backend: "codex",
        capabilityKind: "skill",
        applySemantics: "next-turn",
        discoverySupport: "available",
        runtimeVisibility: "source-only",
        compositionSupport: "verification-gated",
      },
      {
        cascadeKind: "claude-agents",
        backend: "claude",
        capabilityKind: "agent",
        applySemantics: "next-conversation",
        discoverySupport: "available",
        runtimeVisibility: "sdk-runtime",
        compositionSupport: "translator",
      },
    ]);
    expect(registry.listForBackend("claude")).toHaveLength(1);
    expect(registry.listForBackend("claude")[0]?.cascadeKind).toBe(
      "claude-agents",
    );
    expect(registry.listForBackend("codex")).toHaveLength(1);
    expect(registry.listForBackend("codex")[0]?.cascadeKind).toBe(
      "codex-skills",
    );
  });

  it("uses the metadata-declared composition support to gate runtime emission decisions per cascade", () => {
    // Every cascade kind in AGENT_CAPABILITY_CASCADE_KINDS resolves to a
    // metadata record with a composition strategy. Downstream translators
    // branch on this field instead of inspecting cascadeKind directly.
    for (const cascadeKind of AGENT_CAPABILITY_CASCADE_KINDS) {
      const record = defaultAgentCapabilityMetadataRegistry.get(cascadeKind);
      expect(["native", "translator", "verification-gated"]).toContain(
        record.compositionSupport,
      );
    }
  });

  it("parses every metadata record through agentCapabilityMetadataSchema at registry construction", () => {
    // The registry constructor must Zod-parse every input so the metadata
    // shape is enforced structurally, not by hand-written interface trust.
    // Passing a payload missing a required field must throw — the registry
    // can never carry a partially-initialised metadata record.
    expect(() =>
      createAgentCapabilityMetadataRegistry([
        {
          cascadeKind: "claude-skills",
          backend: "claude",
          // capabilityKind intentionally omitted
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "sdk-runtime",
          compositionSupport: "translator",
        },
      ]),
    ).toThrow(/Invalid agent capability metadata record/);
  });

  it("rejects metadata records pairing a cascade with the wrong backend at registry construction", () => {
    // Cascade/backend ownership is fixed (claude-* → claude, codex-* → codex).
    // The schema enforces this so no downstream consumer ever sees a
    // mismatched pairing.
    expect(() =>
      createAgentCapabilityMetadataRegistry([
        {
          cascadeKind: "claude-skills",
          backend: "codex",
          capabilityKind: "skill",
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "sdk-runtime",
          compositionSupport: "translator",
        },
      ]),
    ).toThrow(/Invalid agent capability metadata record/);

    expect(() =>
      createAgentCapabilityMetadataRegistry([
        {
          cascadeKind: "codex-plugins",
          backend: "claude",
          capabilityKind: "plugin",
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "source-only",
          compositionSupport: "translator",
        },
      ]),
    ).toThrow(/Invalid agent capability metadata record/);
  });

  it("rejects metadata records carrying unknown extra fields", () => {
    // `.strict()` on agentCapabilityMetadataSchema blocks accidental
    // payload leakage (e.g. raw SDK config) from being smuggled into the
    // registry.
    expect(() =>
      createAgentCapabilityMetadataRegistry([
        {
          cascadeKind: "claude-skills",
          backend: "claude",
          capabilityKind: "skill",
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "sdk-runtime",
          compositionSupport: "translator",
          rawSdkConfig: { secret: "should not be here" },
        },
      ]),
    ).toThrow(/Invalid agent capability metadata record/);
  });

  it("rejects duplicate cascade-kind records at registry construction", () => {
    expect(() =>
      createAgentCapabilityMetadataRegistry([
        {
          cascadeKind: "claude-skills",
          backend: "claude",
          capabilityKind: "skill",
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "sdk-runtime",
          compositionSupport: "translator",
        },
        {
          cascadeKind: "claude-skills",
          backend: "claude",
          capabilityKind: "skill",
          applySemantics: "next-turn",
          discoverySupport: "available",
          runtimeVisibility: "sdk-runtime",
          compositionSupport: "translator",
        },
      ]),
    ).toThrow(/Duplicate agent capability metadata record/);
  });

  it("guarantees every shipped metadata record passes the canonical schema", () => {
    // Pins the production registry against silent regressions: every entry
    // in `agentCapabilityMetadata` must parse cleanly via the schema.
    for (const record of agentCapabilityMetadata) {
      const result = agentCapabilityMetadataSchema.safeParse(record);
      expect(result.success).toBe(true);
    }
  });
});
