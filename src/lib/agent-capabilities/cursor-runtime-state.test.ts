import { expect, it } from "vitest";
import { reconcileDeliveredCapabilityState } from "./runtime-seed";
import { computeCascadeRuntimeHash } from "./runtime-hashes";
it("keeps resumed selections applied and current overrides deferred", () => {
  const enabled = [
    { itemId: "check", enabled: true, originLayer: "global" as const },
  ];
  const disabled = [{ itemId: "check", enabled: false }];
  const oldHash = computeCascadeRuntimeHash({
    cascadeKind: "cursor-skills",
    rows: enabled,
  });
  const nextHash = computeCascadeRuntimeHash({
    cascadeKind: "cursor-skills",
    rows: disabled,
  });
  expect(
    reconcileDeliveredCapabilityState(
      {
        cascades: {
          "cursor-skills": {
            appliedHash: nextHash,
            lastApplyStatus: "applied",
          },
        },
      },
      { backend: "cursor", kinds: [{ kind: "skills", items: enabled }] },
    ),
  ).toEqual({
    cascades: {
      "cursor-skills": {
        appliedHash: oldHash,
        pendingHash: nextHash,
        lastApplyStatus: "deferred-next-conversation",
      },
    },
  });
});

it("resolves Cursor plugin suppression through all four cascade layers", async () => {
  const { composeConversationStartRuntime } =
    await import("./runtime-composer");
  const result = composeConversationStartRuntime({
    backend: "cursor",
    scope: {
      level: "conversation",
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
      conversationScope: "session",
    },
    overrideChain: [
      {
        layer: "global",
        overrides: {
          cascades: {
            "cursor-skills": { items: { "review:check": { enabled: false } } },
          },
        },
      },
      {
        layer: "project",
        overrides: {
          cascades: {
            "cursor-skills": { items: { "review:check": { enabled: true } } },
          },
        },
      },
      {
        layer: "session",
        overrides: {
          cascades: {
            "cursor-plugins": { items: { review: { enabled: false } } },
          },
        },
      },
      {
        layer: "conversation",
        overrides: {
          cascades: {
            "cursor-skills": { items: { "review:check": { enabled: true } } },
          },
        },
      },
    ],
    discoveryByCascade: {
      "cursor-plugins": {
        items: [
          {
            itemId: "review",
            displayName: "Review",
            capabilityKind: "plugin",
            source: { kind: "user-file", path: "/plugin" },
            nativeDefault: { enabled: true },
            runtimeVisibility: "source-only",
          },
        ],
      },
      "cursor-skills": {
        items: [
          {
            itemId: "review:check",
            displayName: "Check",
            capabilityKind: "skill",
            source: { kind: "user-file", path: "/plugin/check/SKILL.md" },
            owningPluginId: "review",
            nativeDefault: { enabled: true },
            runtimeVisibility: "source-only",
          },
        ],
      },
      "cursor-agents": { items: [] },
    },
  });
  expect(
    result.capabilities.kinds.find((kind) => kind.kind === "skills")?.items,
  ).toEqual([
    expect.objectContaining({
      itemId: "review:check",
      enabled: false,
      originLayer: "session",
    }),
  ]);
});
