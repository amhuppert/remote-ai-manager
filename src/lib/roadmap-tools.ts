import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createRoadmapItem,
  deleteRoadmapItem,
  getRoadmapItems,
} from "@/lib/state";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { roadmapItemTypeSchema } from "@/lib/schemas";
import type { RoadmapItem } from "@/types";

const logger = createLogger("roadmap-tools");

export interface RoadmapToolContext {
  projectPath: string;
}

/**
 * Creates an in-process MCP server with roadmap item management tools.
 * Registered unconditionally in the prompt pipeline for every conversation.
 */
export function createRoadmapToolServer(
  context: RoadmapToolContext,
): McpSdkServerConfigWithInstance {
  const { projectPath } = context;

  return createSdkMcpServer({
    name: "roadmap-tools",
    version: "1.0.0",
    tools: [
      tool(
        "add_roadmap_item",
        "Add a new roadmap item (bug, feature, or idea) to the project's roadmap. Use this to track work items discovered during the coding session.",
        {
          title: z.string().min(1).describe("Title of the roadmap item"),
          type: roadmapItemTypeSchema.describe(
            "Type of item: bug, feature, or idea",
          ),
          description: z
            .string()
            .optional()
            .describe("Optional description with more detail"),
        },
        async (args) => {
          try {
            const item = await createRoadmapItem(projectPath, {
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
        },
      ),

      tool(
        "remove_roadmap_item",
        "Remove a roadmap item by its ID from the project's roadmap.",
        {
          item_id: z
            .string()
            .min(1)
            .describe("ID of the roadmap item to remove"),
        },
        async (args) => {
          try {
            await deleteRoadmapItem(projectPath, args.item_id);

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
        },
      ),

      tool(
        "list_roadmap_items",
        "List all active (non-archived) roadmap items for the project. Use this to see existing items before adding new ones.",
        {},
        async () => {
          try {
            const allItems = await getRoadmapItems(projectPath);
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
              lines.push(
                `\n## ${type.charAt(0).toUpperCase() + type.slice(1)}s`,
              );
              for (const item of typeItems) {
                const status =
                  item.status === "done" ? "[done]" : "[incomplete]";
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
        },
      ),
    ],
  });
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
