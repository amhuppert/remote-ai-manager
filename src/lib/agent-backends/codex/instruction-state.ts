import { createHash } from "node:crypto";
import { z } from "zod";
import {
  appendTranscriptEntry,
  getTranscriptPath,
} from "@/lib/prompt/transcript";
import { readCodexTranscriptRecords } from "./transcript-records";
import { errnoCode } from "@/lib/shared/process-identity";

export interface CodexInstructionRecord {
  version: 1;
  threadRef: string;
  hash: string;
  unresolved: boolean;
}
export interface CodexInstructionStore {
  readLatest(threadRef: string): Promise<CodexInstructionRecord | null>;
  write(record: CodexInstructionRecord): Promise<void>;
}
const recordSchema = z.object({
  version: z.literal(1),
  threadRef: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  unresolved: z.boolean(),
});
const frameSchema = z.object({
  type: z.literal("codex_instruction_state"),
  raw: recordSchema,
});

export function composeCodexGoverningInstructions(
  blocks: readonly string[],
): string {
  const text = blocks.filter((block) => block.length > 0).join("\n\n");
  return `The following is the current complete Command Center governing instruction block. It supersedes earlier Command Center governing blocks, while retaining Codex's base instructions.\n\n${text}`;
}

export function createCodexInstructionStore(
  conversationId: string,
  configDir?: string,
): CodexInstructionStore {
  return {
    async readLatest(threadRef) {
      const file = await getTranscriptPath(conversationId, configDir);
      let latest: CodexInstructionRecord | null = null;
      try {
        for await (const entry of readCodexTranscriptRecords(file)) {
          const parsed = frameSchema.safeParse(entry);
          if (parsed.success && parsed.data.raw.threadRef === threadRef)
            latest = parsed.data.raw;
          else if (
            typeof entry === "object" &&
            entry !== null &&
            "type" in entry &&
            entry.type === "codex_instruction_state" &&
            !parsed.success
          ) {
            throw new Error("Cannot confirm malformed Codex instruction state");
          }
        }
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") throw error;
      }
      return latest;
    },
    async write(record) {
      await appendTranscriptEntry(
        conversationId,
        {
          timestamp: new Date().toISOString(),
          type: "codex_instruction_state",
          raw: record,
        },
        configDir,
      );
    },
  };
}
export class CodexInstructionState {
  private current: CodexInstructionRecord | null = null;
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly store: CodexInstructionStore) {}

  private persist(record: CodexInstructionRecord): Promise<void> {
    const write = this.writes.then(() => this.store.write(record));
    // The caller observes this failure; a later admitted attempt may retry storage.
    this.writes = write.catch(() => {});
    return write;
  }

  async establish(
    threadRef: string,
    text: string,
    fresh: boolean,
    deliver: (text: string) => Promise<void>,
  ): Promise<void> {
    const generation = this.generation;
    const hash = createHash("sha256")
      .update(`cc-governing-v1\0${text}`)
      .digest("hex");
    const latest = fresh ? null : await this.store.readLatest(threadRef);
    this.current = { version: 1, threadRef, hash, unresolved: true };
    if (
      !fresh &&
      latest?.hash === hash &&
      !latest.unresolved &&
      generation === this.generation
    ) {
      this.current = latest;
      return;
    }
    if (!fresh) {
      await this.persist(this.current);
      await deliver(text);
    }
    if (generation !== this.generation)
      throw new Error(
        "Governing instruction acknowledgement invalidated by context loss",
      );
    await this.persist({ ...this.current, unresolved: false });
    if (generation !== this.generation) {
      await this.writes;
      throw new Error(
        "Governing instruction acknowledgement invalidated by context loss",
      );
    }
    this.current = { ...this.current, unresolved: false };
  }

  async invalidate(): Promise<void> {
    this.generation += 1;
    if (this.current === null) return;
    this.current = { ...this.current, unresolved: true };
    await this.persist(this.current);
  }
}
