import { commandItemSchema } from "@/lib/commands/schemas";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { createLogger } from "@/lib/logging";
import {
  discoverCursorCatalog,
  cursorSkillCommands,
  selectCursorCatalog,
  renderCursorSkillCatalog,
} from "./capability-catalog";
import { z } from "zod";
import {
  cursorAgentDefinitionSchema,
  type CursorCatalogInput,
} from "./capability-catalog";
import {
  resolvedCapabilityCascadeSchema,
  type ResolvedCapabilityCascade,
} from "../runtime-config";

export const cursorCapabilitySnapshotSchema = z.object({
  catalog: z.string(),
  commands: z.array(commandItemSchema),
  agents: z.record(z.string(), cursorAgentDefinitionSchema),
  delivered: z.boolean(),
  capabilities: resolvedCapabilityCascadeSchema,
});
export type CursorCapabilitySnapshot = z.infer<
  typeof cursorCapabilitySnapshotSchema
>;
export interface CursorCapabilityDelivery {
  snapshot: CursorCapabilitySnapshot;
  markDelivered(): Promise<void>;
}
export interface CursorCapabilityDeliveryInput extends CursorCatalogInput {
  storePath: string;
  resumed: boolean;
  hermetic: boolean;
  resolved?: ResolvedCapabilityCascade;
}
const logger = createLogger("cursor:capability-delivery");
export async function prepareCursorCapabilityDelivery(
  input: CursorCapabilityDeliveryInput,
): Promise<CursorCapabilityDelivery> {
  if (input.hermetic)
    return {
      snapshot: {
        catalog: "",
        commands: [],
        agents: {},
        delivered: true,
        capabilities: { backend: "cursor", kinds: [] },
      },
      async markDelivered() {},
    };
  const file = path.join(input.storePath, "cc-capabilities.json");
  let snapshot: CursorCapabilitySnapshot | undefined;
  if (input.resumed)
    snapshot = await readCursorCapabilitySnapshot(input.storePath);
  if (!snapshot) {
    const catalog = await discoverCursorCatalog(input);
    const selected = selectCursorCatalog(catalog, input.resolved);
    const agents = Object.fromEntries(
      selected.flatMap((item) =>
        item.kind === "agents" && item.definition
          ? [[item.id, item.definition]]
          : [],
      ),
    );
    const capabilities: ResolvedCapabilityCascade = {
      backend: "cursor",
      kinds: (["skills", "plugins", "agents"] as const).map((kind) => ({
        kind,
        items: catalog.items
          .filter((item) => item.kind === kind && item.scope !== "managed")
          .map((item) => ({
            itemId: item.id,
            enabled: selected.includes(item),
            originLayer:
              input.resolved?.kinds
                .find((k) => k.kind === kind)
                ?.items.find((i) => i.itemId === item.id)?.originLayer ??
              "native",
          })),
      })),
    };
    snapshot = {
      catalog: renderCursorSkillCatalog(selected),
      commands: cursorSkillCommands(selected),
      agents,
      delivered: false,
      capabilities,
    };
    await atomicWriteJson(file, snapshot);
  }
  const current = snapshot;
  logger.info("cursor_capabilities.prepared", {
    resumed: input.resumed,
    catalogChars: current.catalog.length,
    agentCount: Object.keys(current.agents).length,
    delivered: current.delivered,
  });
  return {
    snapshot: current,
    async markDelivered() {
      if (current.delivered) return;
      await atomicWriteJson(file, { ...current, delivered: true });
      current.delivered = true;
      logger.info("cursor_capabilities.delivered", {
        catalogChars: current.catalog.length,
      });
    },
  };
}

export async function readCursorCapabilitySnapshot(
  storePath: string,
): Promise<CursorCapabilitySnapshot | undefined> {
  try {
    return cursorCapabilitySnapshotSchema.parse(
      JSON.parse(
        await readFile(path.join(storePath, "cc-capabilities.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
