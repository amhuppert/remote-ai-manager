import { z } from "zod";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import type { CodexUsageTokens } from "./pricing";

const object = z.record(z.string(), z.unknown());
const itemEnvelope = z.object({
  item: z.looseObject({ id: z.string(), type: z.string() }),
});
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = object.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Projects completed items only; raw frames retain every incremental update. */
export class CodexAppServerEvents {
  finalText: string | null = null;
  compacted = false;
  private pending: string | null = null;
  private readonly phases = new Map<string, "commentary" | "final_answer">();
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();

  private flushPending(final: boolean): MessageContentBlock[] {
    if (this.pending === null) return [];
    const text = this.pending;
    this.pending = null;
    if (final) this.finalText = text;
    return [{ type: final ? "text" : "thinking", text }];
  }

  consume(method: string, params: unknown): MessageContentBlock[] {
    if (method === "thread/compacted") {
      this.compacted = true;
      return [];
    }
    if (method === "turn/plan/updated") {
      const parsed = object.safeParse(params);
      if (!parsed.success) throw new Error("Invalid Codex plan notification");
      return [
        {
          type: "tool_use",
          id: "codex-plan",
          name: "TodoWrite",
          input: {
            todos: records(parsed.data.plan).map((step) => ({
              content: string(step.step),
              status: step.status,
            })),
          },
        },
      ];
    }
    if (method !== "item/started" && method !== "item/completed") return [];
    const parsed = itemEnvelope.safeParse(params);
    if (!parsed.success) throw new Error("Invalid Codex item notification");
    const item = parsed.data.item;
    const done = method === "item/completed";
    const seen = done ? this.completed : this.started;
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    if (item.type === "userMessage") return [];
    if (item.type === "contextCompaction") {
      this.compacted = true;
      return [];
    }
    if (item.type === "agentMessage") {
      if (item.phase === "commentary" || item.phase === "final_answer")
        this.phases.set(item.id, item.phase);
      if (!done) return [];
      if (typeof item.text !== "string")
        throw new Error("Invalid Codex agent message");
      const blocks = this.flushPending(false);
      const phase = this.phases.get(item.id);
      this.phases.delete(item.id);
      if (phase === "final_answer") {
        this.finalText = item.text;
        blocks.push({ type: "text", text: item.text });
      } else if (phase === "commentary")
        blocks.push({ type: "thinking", text: item.text });
      else this.pending = item.text;
      return blocks;
    }
    const blocks: MessageContentBlock[] = [];
    const tool = (name: string, input: Record<string, unknown>) => ({
      type: "tool_use" as const,
      id: item.id,
      name,
      input,
    });
    switch (item.type) {
      case "commandExecution": {
        blocks.push(...this.flushPending(false));
        if (!done)
          blocks.push(
            tool("Bash", {
              command: string(item.command).replace(
                /^\/bin\/(?:ba|z)?sh\s+-lc\s+(['"])(.*)\1$/s,
                "$2",
              ),
            }),
          );
        else {
          const exitCode =
            typeof item.exitCode === "number" ? item.exitCode : undefined;
          const isError =
            item.status === "failed" ||
            (exitCode !== undefined && exitCode !== 0);
          if (item.aggregatedOutput || isError)
            blocks.push({
              type: "tool_result",
              tool_use_id: item.id,
              content: string(item.aggregatedOutput) || undefined,
              ...(isError ? { isError: true } : {}),
              ...(exitCode === undefined ? {} : { metrics: { exitCode } }),
            });
        }
        break;
      }
      case "mcpToolCall": {
        blocks.push(...this.flushPending(false));
        if (!done)
          blocks.push(
            tool(string(item.tool), {
              server: item.server,
              arguments: item.arguments,
            }),
          );
        else {
          const result = object.safeParse(item.result);
          const error = object.safeParse(item.error);
          const content = result.success
            ? records(result.data.content)
                .filter((block) => block.type === "text")
                .map((block) => string(block.text))
                .join("\n") ||
              (result.data.structuredContent == null
                ? undefined
                : JSON.stringify(result.data.structuredContent))
            : error.success
              ? string(error.data.message)
              : undefined;
          const isError = item.status === "failed" || item.error != null;
          const metrics = parseToolResultMetrics(string(item.tool), content);
          blocks.push({
            type: "tool_result",
            tool_use_id: item.id,
            content,
            ...(isError ? { isError: true } : {}),
            ...(Object.keys(metrics).length ? { metrics } : {}),
          });
        }
        break;
      }
      case "fileChange": {
        if (!done) break;
        blocks.push(...this.flushPending(false));
        for (const [index, change] of records(item.changes).entries()) {
          const kind = object.safeParse(change.kind);
          const name =
            kind.success && kind.data.type === "add"
              ? "Write"
              : kind.success && kind.data.type === "delete"
                ? "Delete"
                : "Edit";
          const id = `${item.id}:${index}`;
          blocks.push({
            type: "tool_use",
            id,
            name,
            input: { file_path: string(change.path) },
          });
          if (item.status === "failed")
            blocks.push({
              type: "tool_result",
              tool_use_id: id,
              isError: true,
            });
        }
        break;
      }
      case "reasoning": {
        if (!done) break;
        blocks.push(...this.flushPending(false));
        const text = [item.summary, item.content]
          .flatMap((parts) =>
            Array.isArray(parts)
              ? parts.filter((part): part is string => typeof part === "string")
              : [],
          )
          .join("\n");
        if (text) blocks.push({ type: "thinking", text });
        break;
      }
      case "webSearch":
        if (!done) {
          blocks.push(...this.flushPending(false));
          blocks.push(tool("WebSearch", { query: item.query }));
        }
        break;
      case "plan":
        if (done && typeof item.text === "string")
          blocks.push({ type: "thinking", text: item.text });
        break;
    }
    return blocks;
  }
  finish(): MessageContentBlock[] {
    return this.flushPending(true);
  }
}

const counter = z.number().int().nonnegative();
const counters = z.object({
  inputTokens: counter,
  cachedInputTokens: counter,
  cacheWriteInputTokens: counter.default(0),
  outputTokens: counter,
  reasoningOutputTokens: counter,
  totalTokens: counter,
});
type Counters = z.infer<typeof counters>;
const usageEnvelope = z.object({ tokenUsage: z.object({ total: counters }) });
const fields = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
export class CodexAppServerUsage {
  private previous: Counters | null = null;
  private baseline: Counters | null = null;
  private invalidated = false;
  private measuredTurn = false;
  observe(params: unknown, beforeStart: boolean): void {
    const parsed = usageEnvelope.safeParse(params);
    if (!parsed.success) {
      this.invalidated = true;
      return;
    }
    const total = parsed.data.tokenUsage.total;
    if (
      total.totalTokens !== total.inputTokens + total.outputTokens ||
      total.cachedInputTokens > total.inputTokens ||
      total.reasoningOutputTokens > total.outputTokens ||
      total.cacheWriteInputTokens > total.inputTokens
    )
      this.invalidated = true;
    const previous = this.previous;
    if (previous && fields.some((field) => total[field] < previous[field]))
      this.invalidated = true;
    if (
      previous &&
      (total.cachedInputTokens - previous.cachedInputTokens >
        total.inputTokens - previous.inputTokens ||
        total.cacheWriteInputTokens - previous.cacheWriteInputTokens >
          total.inputTokens - previous.inputTokens ||
        total.reasoningOutputTokens - previous.reasoningOutputTokens >
          total.outputTokens - previous.outputTokens)
    )
      this.invalidated = true;
    this.previous = total;
    if (beforeStart) this.baseline = total;
    else this.measuredTurn = true;
  }
  get hasBaseline(): boolean {
    return this.baseline !== null;
  }
  get tokens(): CodexUsageTokens | null {
    if (this.invalidated || !this.measuredTurn || !this.previous) return null;
    return {
      input_tokens:
        this.previous.inputTokens - (this.baseline?.inputTokens ?? 0),
      cached_input_tokens:
        this.previous.cachedInputTokens -
        (this.baseline?.cachedInputTokens ?? 0),
      output_tokens:
        this.previous.outputTokens - (this.baseline?.outputTokens ?? 0),
    };
  }
  get invalid(): boolean {
    return this.invalidated;
  }
}
