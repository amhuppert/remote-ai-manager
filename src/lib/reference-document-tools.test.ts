import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceDocument } from "@/types";
import {
  registerReferenceDocumentTools,
  type ReferenceDocumentToolDeps,
} from "./reference-document-tools";

type ToolHandler = (args: unknown) => Promise<unknown>;

const TOOLS_KEY = "__test_refdoc_tool_captured";

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

const CONTEXT = {
  projectPath: "/projects/test",
  sessionName: "test-session",
  worktreePath: "/tmp/wt",
};

function registerTools(deps: ReferenceDocumentToolDeps): void {
  registerReferenceDocumentTools(
    createCapturingServer() as never,
    CONTEXT,
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

function makeDoc(overrides?: Partial<ReferenceDocument>): ReferenceDocument {
  return {
    id: "doc-1",
    filePath: ".cc/references/design.md",
    description: "Architecture notes",
    createdAt: "2026-03-30T12:00:00.000Z",
    ...overrides,
  };
}

function createMockDeps(): ReferenceDocumentToolDeps & {
  mockCreate: ReturnType<typeof vi.fn>;
  mockDelete: ReturnType<typeof vi.fn>;
  mockGet: ReturnType<typeof vi.fn>;
  mockDeleteFile: ReturnType<typeof vi.fn>;
} {
  const mockCreate = vi.fn();
  const mockDelete = vi.fn();
  const mockGet = vi.fn();
  const mockDeleteFile = vi.fn();
  return {
    createReferenceDocument: mockCreate,
    deleteReferenceDocument: mockDelete,
    getReferenceDocuments: mockGet,
    deleteFile: mockDeleteFile,
    mockCreate,
    mockDelete,
    mockGet,
    mockDeleteFile,
  };
}

describe("reference-document-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCapturedTools().clear();
  });

  it("registers the three reference document tools", () => {
    const deps = createMockDeps();
    registerTools(deps);

    expect(getCapturedTools().has("register_document")).toBe(true);
    expect(getCapturedTools().has("list_documents")).toBe(true);
    expect(getCapturedTools().has("delete_document")).toBe(true);
  });

  describe("register_document", () => {
    it("registers a document and returns confirmation", async () => {
      const deps = createMockDeps();
      const doc = makeDoc({ filePath: ".cc/references/plan.md" });
      deps.mockCreate.mockResolvedValue(doc);
      registerTools(deps);

      const handler = getHandler("register_document");
      const result = (await handler({
        file_path: ".cc/references/plan.md",
        description: "Architecture notes",
      })) as { content: Array<{ text: string }> };

      expect(deps.mockCreate).toHaveBeenCalledWith(
        "/projects/test",
        "test-session",
        ".cc/references/plan.md",
        "Architecture notes",
      );
      expect(result.content[0]?.text).toContain(".cc/references/plan.md");
    });

    it("returns isError on failure", async () => {
      const deps = createMockDeps();
      deps.mockCreate.mockRejectedValue(new Error("State write failed"));
      registerTools(deps);

      const handler = getHandler("register_document");
      const result = (await handler({
        file_path: "file.md",
        description: "desc",
      })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("State write failed");
    });
  });

  describe("list_documents", () => {
    it("returns formatted list of documents", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([
        makeDoc({ id: "d1", filePath: "a.md", description: "Doc A" }),
        makeDoc({ id: "d2", filePath: "b.md", description: "Doc B" }),
      ]);
      registerTools(deps);

      const handler = getHandler("list_documents");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      const text = result.content[0]?.text ?? "";
      expect(text).toContain("a.md");
      expect(text).toContain("Doc A");
      expect(text).toContain("b.md");
      expect(text).toContain("Doc B");
    });

    it("returns empty message when no documents", async () => {
      const deps = createMockDeps();
      deps.mockGet.mockResolvedValue([]);
      registerTools(deps);

      const handler = getHandler("list_documents");
      const result = (await handler({})) as {
        content: Array<{ text: string }>;
      };

      expect(result.content[0]?.text).toContain("No reference documents");
    });
  });

  describe("delete_document", () => {
    it("deletes document and file, returns confirmation", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockResolvedValue(
        makeDoc({ id: "doc-1", filePath: ".cc/references/old.md" }),
      );
      deps.mockDeleteFile.mockResolvedValue(undefined);
      registerTools(deps);

      const handler = getHandler("delete_document");
      const result = (await handler({ document_id: "doc-1" })) as {
        content: Array<{ text: string }>;
      };

      expect(deps.mockDelete).toHaveBeenCalledWith(
        "/projects/test",
        "test-session",
        "doc-1",
      );
      expect(deps.mockDeleteFile).toHaveBeenCalledWith(
        "/tmp/wt/.cc/references/old.md",
      );
      expect(result.content[0]?.text).toContain("doc-1");
    });

    it("returns error when document not found", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockResolvedValue(null);
      registerTools(deps);

      const handler = getHandler("delete_document");
      const result = (await handler({ document_id: "nonexistent" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not found");
      expect(deps.mockDeleteFile).not.toHaveBeenCalled();
    });

    it("passes absolute filePath directly to deleteFile", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockResolvedValue(
        makeDoc({ id: "doc-1", filePath: "/absolute/path/doc.md" }),
      );
      deps.mockDeleteFile.mockResolvedValue(undefined);
      registerTools(deps);

      const handler = getHandler("delete_document");
      await handler({ document_id: "doc-1" });

      expect(deps.mockDeleteFile).toHaveBeenCalledWith("/absolute/path/doc.md");
    });

    it("tolerates file already deleted from disk", async () => {
      const deps = createMockDeps();
      deps.mockDelete.mockResolvedValue(
        makeDoc({ id: "doc-1", filePath: ".cc/references/gone.md" }),
      );
      deps.mockDeleteFile.mockResolvedValue(undefined);
      registerTools(deps);

      const handler = getHandler("delete_document");
      const result = (await handler({ document_id: "doc-1" })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("doc-1");
    });
  });
});
