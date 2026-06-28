import { describe, expect, it } from "vitest";
import { extractMarkdownFileRefs } from "./markdown-file-refs";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";

function toolUse(
  name: string,
  input: Record<string, unknown>,
  id?: string,
): MessageContentBlock {
  return id
    ? { type: "tool_use", id, name, input }
    : { type: "tool_use", name, input };
}

function toolResult(toolUseId: string, content: string): MessageContentBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content };
}

describe("extractMarkdownFileRefs — native edits", () => {
  it("detects a Write on a .md file with origin 'write'", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("Write", { file_path: "docs/guide.md" }),
    ]);
    expect(refs).toEqual([
      { docPath: "docs/guide.md", fileName: "guide.md", origin: "write" },
    ]);
  });

  it("detects an Edit with origin 'edit'", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("Edit", { file_path: "a/b/notes.md" }),
    ]);
    expect(refs[0]?.origin).toBe("edit");
    expect(refs[0]?.fileName).toBe("notes.md");
  });

  it("counts MultiEdit as an edit", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("MultiEdit", { file_path: ".kiro/specs/x/tasks.md" }),
    ]);
    expect(refs).toEqual([
      {
        docPath: ".kiro/specs/x/tasks.md",
        fileName: "tasks.md",
        origin: "edit",
      },
    ]);
  });

  it("ignores Write/Edit on non-markdown files", () => {
    expect(
      extractMarkdownFileRefs([
        toolUse("Write", { file_path: "src/index.ts" }),
        toolUse("Edit", { file_path: "package.json" }),
      ]),
    ).toEqual([]);
  });

  it("ignores unrelated tools like Read even on a .md file", () => {
    expect(
      extractMarkdownFileRefs([toolUse("Read", { file_path: "design.md" })]),
    ).toEqual([]);
  });
});

describe("extractMarkdownFileRefs — registered documents", () => {
  it("detects an MCP-namespaced register_document", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("mcp__cc-session-tools__register_document", {
        file_path: "memory-bank/plan.md",
      }),
    ]);
    expect(refs).toEqual([
      {
        docPath: "memory-bank/plan.md",
        fileName: "plan.md",
        origin: "registered",
      },
    ]);
  });

  it("accepts the bare register_document name too", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("register_document", { file_path: "memory-bank/plan.md" }),
    ]);
    expect(refs[0]?.origin).toBe("registered");
  });

  it("ignores register_document on a non-markdown file", () => {
    expect(
      extractMarkdownFileRefs([
        toolUse("mcp__cc-session-tools__register_document", {
          file_path: "diagram.png",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("extractMarkdownFileRefs — run_codex paired results", () => {
  it("emits a registered ref for each .md in the paired tool_result referenceDocuments", () => {
    const blocks: MessageContentBlock[] = [
      toolUse(
        "mcp__cc-session-tools__run_codex",
        { task: "analyze" },
        "codex-1",
      ),
      toolResult(
        "codex-1",
        JSON.stringify({
          summary: "did the thing",
          referenceDocuments: [
            { filePath: "analysis/report.md", description: "the report" },
            { filePath: "analysis/data.csv", description: "raw data" },
          ],
        }),
      ),
    ];
    const refs = extractMarkdownFileRefs(blocks);
    expect(refs).toEqual([
      {
        docPath: "analysis/report.md",
        fileName: "report.md",
        origin: "registered",
      },
    ]);
  });

  it("ignores run_codex whose paired result is missing or unparseable", () => {
    expect(
      extractMarkdownFileRefs([toolUse("run_codex", { task: "x" }, "codex-2")]),
    ).toEqual([]);
    expect(
      extractMarkdownFileRefs([
        toolUse("run_codex", { task: "x" }, "codex-3"),
        toolResult("codex-3", "not json at all"),
      ]),
    ).toEqual([]);
  });
});

describe("extractMarkdownFileRefs — de-duplication", () => {
  it("de-dupes by docPath within a message", () => {
    const refs = extractMarkdownFileRefs([
      toolUse("Write", { file_path: "design.md" }),
      toolUse("Edit", { file_path: "design.md" }),
      toolUse("mcp__cc-session-tools__register_document", {
        file_path: "design.md",
      }),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.docPath).toBe("design.md");
  });
});
