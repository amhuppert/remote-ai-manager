import { z } from "zod";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import { isMarkdownPath } from "./path";

/**
 * Derives clickable markdown file cards from a message's tool_use blocks. Pure
 * (no DOM/IO) so it runs at transcript render time on the client. The returned
 * `docPath` is the raw tool-supplied path; the viewer's content endpoint
 * normalizes it (absolute-inside→relative, outside→unavailable) on open.
 */

export type MarkdownFileRefOrigin = "write" | "edit" | "registered";

export interface MarkdownFileRef {
  docPath: string;
  fileName: string;
  origin: MarkdownFileRefOrigin;
}

/** Native edit tools (SDK built-ins, not MCP-namespaced) → file-card origin. */
const NATIVE_EDIT_ORIGINS: Record<string, "write" | "edit"> = {
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
};

/**
 * Strip the `mcp__<server>__` prefix from a tool name, returning the bare tool.
 * The transcript stores the full MCP name (e.g.
 * `mcp__playwright__browser_click`); bare names pass through unchanged.
 */
function normalizeToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  // mcp__<server>__<tool>: the tool is everything after the second `__`.
  return parts.length >= 3 ? parts.slice(2).join("__") : name;
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

const codexResultSchema = z.object({
  referenceDocuments: z.array(z.object({ filePath: z.string() })),
});

/** Parse a `run_codex` tool_result content string into its reference documents. */
function parseCodexReferenceDocuments(content: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  const parsed = codexResultSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.referenceDocuments.map((d) => d.filePath);
}

export function extractMarkdownFileRefs(
  blocks: MessageContentBlock[],
): MarkdownFileRef[] {
  // Index tool_results by their tool_use_id so a run_codex tool_use can find its
  // paired result and read the reference documents Codex auto-registered.
  const resultContentById = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === "tool_result" && typeof block.content === "string") {
      resultContentById.set(block.tool_use_id, block.content);
    }
  }

  const refs: MarkdownFileRef[] = [];
  const seen = new Set<string>();
  const add = (docPath: string, origin: MarkdownFileRefOrigin): void => {
    if (!isMarkdownPath(docPath) || seen.has(docPath)) return;
    seen.add(docPath);
    refs.push({ docPath, fileName: baseName(docPath), origin });
  };

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const tool = normalizeToolName(block.name);
    const filePath =
      typeof block.input?.file_path === "string"
        ? block.input.file_path
        : undefined;

    const nativeOrigin = NATIVE_EDIT_ORIGINS[tool];
    if (nativeOrigin !== undefined) {
      if (filePath) add(filePath, nativeOrigin);
      continue;
    }

    if (tool === "register_document") {
      if (filePath) add(filePath, "registered");
      continue;
    }

    if (tool === "run_codex" && block.id !== undefined) {
      const content = resultContentById.get(block.id);
      if (content === undefined) continue;
      for (const refPath of parseCodexReferenceDocuments(content)) {
        add(refPath, "registered");
      }
    }
  }

  return refs;
}
