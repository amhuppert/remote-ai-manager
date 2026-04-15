import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoadmapItem } from "@/types";
import { registerRoadmapTools, type RoadmapToolDeps } from "./roadmap-tools";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_roadmap_tool_captured";

function getCapturedTools(): Map<
  string,
  { name: string; handler: ToolHandler }
> {
  const g = globalThis as Record<string, unknown>;
  if (!g[TOOLS_KEY]) {
    g[TOOLS_KEY] = new Map();
  }
  return g[TOOLS_KEY] as Map<string, { name: string; handler: ToolHandler }>;
}

function createCapturingServer() {
  return {
    registerTool(name: string, _config: unknown, handler: ToolHandler): void {
      getCapturedTools().set(name, { name, handler });
    },
  };
}

function registerTools(deps: RoadmapToolDeps): void {
  registerRoadmapTools(
    createCapturingServer() as never,
    { projectPath: "/projects/test" },
    deps,
  );
}

function getHandler(name: string): ToolHandler {
  const tool = getCapturedTools().get(name);
  if (!tool) {
    throw new Error(`Tool ${name} not found in captured tools`);
  }
  return tool.handler;
}

function makeItem(overrides?: Partial<RoadmapItem>): RoadmapItem {
  return {
    id: "item-1",
    title: "Fix login bug",
    description: null,
    type: "bug",
    status: "incomplete",
    archived: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockDeps(): RoadmapToolDeps & {
  mockCreate: ReturnType<typeof vi.fn>;
  mockDelete: ReturnType<typeof vi.fn>;
  mockGet: ReturnType<typeof vi.fn>;
} {
  const mockCreate = vi.fn();
  const mockDelete = vi.fn();
  const mockGet = vi.fn();
  return {
    createRoadmapItem: mockCreate,
    deleteRoadmapItem: mockDelete,
    getRoadmapItems: mockGet,
    mockCreate,
    mockDelete,
    mockGet,
  };
}

describe("roadmap-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers the roadmap tools", () => {
    const deps = createMockDeps();
    registerTools(deps);

    expect(getCapturedTools().has("add_roadmap_item")).toBe(true);
    expect(getCapturedTools().has("remove_roadmap_item")).toBe(true);
    expect(getCapturedTools().has("list_roadmap_items")).toBe(true);
  });

  describe("add_roadmap_item", () => {
    it("creates an item and returns a success summary", async () => {
      const deps = createMockDeps();
      const createdItem = makeItem({
        id: "new-uuid",
        title: "Add dark mode",
        type: "feature",
      });
      deps.mockCreate.mockResolvedValue(createdItem);
      registerTools(deps);

      const handler = getHandler("add_roadmap_item");
      const result = (await handler({
        title: "Add dark mode",
        type: "feature",
      })) as { content: Array<{ type: string; text: string }> };

      expect(deps.mockCreate).toHaveBeenCalledWith("/projects/test", {
        title: "Add dark mode",
        type: "feature",
        description: undefined,
      });
      expect(result.content[0]?.text).toContain("Add dark mode");
      expect(result.content[0]?.text).toContain("new-uuid");
      expect(result.content[0]?.text).toContain("feature");
    });

    it("passes description when provided", async () => {
      const deps = createMockDeps();
      deps.mockCreate.mockResolvedValue(
        makeItem({ title: "Bug fix", description: "Detailed desc" }),
      );
      registerTools(deps);

      const handler = getHandler("add_roadmap_item");
      await handler({
        title: "Bug fix",
        type: "bug",
        description: "Detailed desc",
      });

      expect(deps.mockCreate).toHaveBeenCalledWith("/projects/test", {
        title: "Bug fix",
        type: "bug",
        description: "Detailed desc",
      });
    });

    it("returns isError when state mutation fails", async () => {
      const deps = createMockDeps();
      deps.mockCreate.mockRejectedValue(new Error("State write failed"));
      registerTools(deps);

      const handler = getHandler("add_roadmap_item");
      const result = (await handler({
        title: "Fail item",
        type: "idea",
      })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("State write failed");
    });
  });

  describe("remove_roadmap_item", () => {
    it("deletes an item and returns confirmation", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockResolvedValue(undefined);
      registerTools(deps);

      const handler = getHandler("remove_roadmap_item");
      const result = (await handler({ item_id: "item-1" })) as {
        content: Array<{ text: string }>;
      };

      expect(deps.mockDelete).toHaveBeenCalledWith("/projects/test", "item-1");
      expect(result.content[0]?.text).toContain("item-1");
    });

    it("returns isError when item ID is not found", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockRejectedValue(
        new Error('Roadmap item "nonexistent" not found'),
      );
      registerTools(deps);

      const handler = getHandler("remove_roadmap_item");
      const result = (await handler({ item_id: "nonexistent" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not found");
    });
  });

  describe("list_roadmap_items", () => {
    it("returns formatted list of non-archived items grouped by type", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([
        makeItem({ id: "1", title: "Login bug", type: "bug" }),
        makeItem({
          id: "2",
          title: "Dark mode",
          type: "feature",
          status: "done",
        }),
        makeItem({ id: "3", title: "Refactor idea", type: "idea" }),
      ]);
      registerTools(deps);

      const handler = getHandler("list_roadmap_items");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Login bug");
      expect(text).toContain("Dark mode");
      expect(text).toContain("Refactor idea");
      expect(text).toContain("Bug");
      expect(text).toContain("Feature");
      expect(text).toContain("Idea");
    });

    it("filters out archived items", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([
        makeItem({ id: "1", title: "Active bug", type: "bug" }),
        makeItem({
          id: "2",
          title: "Archived feature",
          type: "feature",
          archived: true,
        }),
      ]);
      registerTools(deps);

      const handler = getHandler("list_roadmap_items");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Active bug");
      expect(text).not.toContain("Archived feature");
    });

    it("returns empty message when no items exist", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([]);
      registerTools(deps);

      const handler = getHandler("list_roadmap_items");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toContain("No roadmap items found");
    });

    it("returns empty message when all items are archived", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([
        makeItem({ id: "1", title: "Old bug", archived: true }),
      ]);
      registerTools(deps);

      const handler = getHandler("list_roadmap_items");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toContain("No roadmap items found");
    });
  });
});
