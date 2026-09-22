import { cursorAgentStorePath } from "./store-path";
import { readCursorCapabilitySnapshot } from "./capability-delivery";
import { createHash } from "node:crypto";
import { discoverCursorCatalog } from "@/lib/agent-backends/cursor/capability-catalog";
import { getPublishedManagedSkillBundle } from "@/lib/managed-skills/service";
import type { CapabilityCatalogInventory } from "../capability-catalog";

export async function discoverCursorCapabilities(
  input: {
    worktreePath: string;
    home: string;
  },
  kind: "skills" | "plugins" | "agents",
): Promise<CapabilityCatalogInventory> {
  const catalog = await discoverCursorCatalog({
    ...input,
    bundle: getPublishedManagedSkillBundle(),
  });
  return {
    items: catalog.items
      .filter((item) => item.kind === kind && item.scope !== "managed")
      .map((item) => ({
        itemId: item.id,
        displayName: item.id,
        capabilityKind:
          kind === "skills" ? "skill" : kind === "plugins" ? "plugin" : "agent",
        source: {
          kind: item.scope === "project" ? "project-file" : "user-file",
          path: item.path,
        },
        nativeDefault: { enabled: true },
        ...(item.pluginId ? { owningPluginId: item.pluginId } : {}),
        runtimeVisibility: "source-only",
      })),
    diagnostics: [
      {
        severity: "info",
        code: "cursor-cc-delivery",
        message:
          "CC supplies selected skill metadata and supported agent definitions at conversation creation. Changes apply to subsequent conversations. Local Cursor plugins contribute supported skills and agents only; remote marketplace activation is not imported.",
        backend: "cursor",
      },
      ...catalog.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        severity: "warning" as const,
        backend: "cursor" as const,
        cascadeKind: `cursor-${kind}` as const,
      })),
    ],
    sourceSignature: createHash("sha256")
      .update(JSON.stringify(catalog))
      .digest("hex"),
    refreshedAt: new Date().toISOString(),
  };
}

export const cursorCapabilityCatalog: import("../capability-catalog").BackendCapabilityCatalogFacet =
  {
    discover(input) {
      return discoverCursorCapabilities(input, input.kind);
    },
    async delivered(conversationId) {
      return (
        (await readCursorCapabilitySnapshot(
          cursorAgentStorePath(conversationId),
        )) ?? undefined
      );
    },
  };
