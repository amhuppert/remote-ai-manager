import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createRoadmapItem as createRoadmapItemDefault,
  deleteRoadmapItem as deleteRoadmapItemDefault,
  getRoadmapItems as getRoadmapItemsDefault,
} from "@/lib/state";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { roadmapItemTypeSchema } from "@/lib/schemas";
import type { RoadmapItem, RoadmapItemType } from "@/types";

const logger = createLogger("roadmap-tools");

export interface RoadmapToolContext {
  projectPath: string;
}

export interface RoadmapToolDeps {
  createRoadmapItem: (
    projectPath: string,
    data: {
      title: string;
      description?: string | null;
      type: RoadmapItemType;
    },
  ) => Promise<RoadmapItem>;
  deleteRoadmapItem: (projectPath: string, itemId: string) => Promise<void>;
  getRoadmapItems: (projectPath: string) => Promise<RoadmapItem[]>;
}

export const defaultRoadmapToolDeps: RoadmapToolDeps = {
  createRoadmapItem: createRoadmapItemDefault,
  deleteRoadmapItem: deleteRoadmapItemDefault,
  getRoadmapItems: getRoadmapItemsDefault,
};

const addRoadmapItemInputSchema = {
  title: z.string().min(1).describe("Title of the roadmap item"),
  type: roadmapItemTypeSchema.describe("Type of item: bug, feature, or idea"),
  description: z
    .string()
    .optional()
    .describe("Optional description with more detail"),
};

const removeRoadmapItemInputSchema = {
  item_id: z.string().min(1).describe("ID of the roadmap item to remove"),
};

function createAddRoadmapItemHandler(
  context: RoadmapToolContext,
  deps: RoadmapToolDeps,
) {
  return async (args: {
    title: string;
    type: RoadmapItemType;
    description?: string;
  }) => {
    try {
      const item = await deps.createRoadmapItem(context.projectPath, {
        title: args.title,
        type: args.type,
        description: args.description,
      });

      logger.info("tool.add_roadmap_item", {
        itemId: item.id,
        type: item.type,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Roadmap item added successfully:\n- ID: ${item.id}\n- Title: ${item.title}\n- Type: ${item.type}`,
          },
        ],
      };
    } catch (error) {
      logger.error("tool.add_roadmap_item.error", {
        error: getErrorMessage(error),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to add roadmap item: ${getErrorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

function createRemoveRoadmapItemHandler(
  context: RoadmapToolContext,
  deps: RoadmapToolDeps,
) {
  return async (args: { item_id: string }) => {
    try {
      await deps.deleteRoadmapItem(context.projectPath, args.item_id);

      logger.info("tool.remove_roadmap_item", {
        itemId: args.item_id,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Roadmap item ${args.item_id} removed successfully.`,
          },
        ],
      };
    } catch (error) {
      logger.error("tool.remove_roadmap_item.error", {
        itemId: args.item_id,
        error: getErrorMessage(error),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to remove roadmap item: ${getErrorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

function createListRoadmapItemsHandler(
  context: RoadmapToolContext,
  deps: RoadmapToolDeps,
) {
  return async () => {
    try {
      const allItems = await deps.getRoadmapItems(context.projectPath);
      const items = allItems.filter((item) => !item.archived);

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No roadmap items found for this project.",
            },
          ],
        };
      }

      const grouped = groupByType(items);
      const lines: string[] = [
        `Roadmap items for this project (${items.length} total):`,
      ];

      for (const [type, typeItems] of grouped) {
        lines.push(`\n## ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
        for (const item of typeItems) {
          const status = item.status === "done" ? "[done]" : "[incomplete]";
          lines.push(`- ${item.title} (ID: ${item.id}) ${status}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    } catch (error) {
      logger.error("tool.list_roadmap_items.error", {
        error: getErrorMessage(error),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to list roadmap items: ${getErrorMessage(error)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

export function registerRoadmapTools(
  server: McpServer,
  context: RoadmapToolContext,
  deps: RoadmapToolDeps = defaultRoadmapToolDeps,
): void {
  server.registerTool(
    "add_roadmap_item",
    {
      description:
        "Add a new roadmap item (bug, feature, or idea) to the project's roadmap. Use this to track work items discovered during the coding session.",
      inputSchema: addRoadmapItemInputSchema,
    },
    createAddRoadmapItemHandler(context, deps),
  );

  server.registerTool(
    "remove_roadmap_item",
    {
      description:
        "Remove a roadmap item by its ID from the project's roadmap.",
      inputSchema: removeRoadmapItemInputSchema,
    },
    createRemoveRoadmapItemHandler(context, deps),
  );

  server.registerTool(
    "list_roadmap_items",
    {
      description:
        "List all active (non-archived) roadmap items for the project. Use this to see existing items before adding new ones.",
      inputSchema: {},
    },
    createListRoadmapItemsHandler(context, deps),
  );
}

function groupByType(items: RoadmapItem[]): Map<string, RoadmapItem[]> {
  const grouped = new Map<string, RoadmapItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.type);
    if (existing) {
      existing.push(item);
    } else {
      grouped.set(item.type, [item]);
    }
  }
  return grouped;
}
