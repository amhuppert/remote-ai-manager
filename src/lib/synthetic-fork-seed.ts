import type { MessageContentBlock } from "@/types";
import { readConversationMessages as defaultReadConversationMessages } from "./transcript";
import { createLogger } from "./logging";
import { getErrorMessage } from "./errors";

const logger = createLogger("synthetic-fork-seed");

const SYNTHETIC_FORK_MAX_CHARS = 24_000;
const SYNTHETIC_FORK_TRUNCATION_PREFIX = "[truncated historical context]\n\n";

/**
 * Minimal message shape consumed by the seed builder. Production passes
 * `TranscriptMessage[]`; tests and the conversation actor may pass narrower
 * objects with just role + content.
 */
interface SyntheticForkSourceMessage {
  role: string;
  content: MessageContentBlock[];
}

export interface SyntheticForkSeedDeps {
  readConversationMessages?(
    transcriptPath: string,
  ): Promise<SyntheticForkSourceMessage[]>;
}

/**
 * Build a text seed from the transcript up to and including the fork point.
 * Used by two callers:
 *
 * 1. The conversation actor's first-turn synthetic-fork path (for non-Claude
 *    backends, or backends without precise fork).
 * 2. forkConversation()'s synthetic-fallback path when the SDK's forkSession
 *    can't anchor (e.g., compacted-away source UUID).
 *
 * Returns null when the transcript is unreadable or contains no relevant
 * messages — callers decide how to treat that.
 */
export async function buildSyntheticForkSeed(
  transcriptPath: string,
  messageIndex: number,
  deps: SyntheticForkSeedDeps = {},
): Promise<string | null> {
  const readMessages =
    deps.readConversationMessages ?? defaultReadConversationMessages;
  try {
    const messages = await readMessages(transcriptPath);
    const forkSlice = messages.slice(0, messageIndex + 1);
    if (forkSlice.length === 0) return null;

    const blocks: string[] = [];
    for (const msg of forkSlice) {
      const role = msg.role === "user" ? "User" : "Assistant";
      const textParts = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) {
        blocks.push(`${role}: ${textParts.join("\n")}`);
      }
    }

    const header =
      "The following is the conversation history up to the fork point. Continue from here:\n";
    let body = blocks.join("\n\n");

    if (header.length + body.length > SYNTHETIC_FORK_MAX_CHARS) {
      const budget =
        SYNTHETIC_FORK_MAX_CHARS -
        header.length -
        SYNTHETIC_FORK_TRUNCATION_PREFIX.length;
      body = SYNTHETIC_FORK_TRUNCATION_PREFIX + body.slice(-budget);
    }

    return header + "\n" + body;
  } catch (err) {
    logger.warn("synthetic_fork_seed.build_failed", {
      transcriptPath,
      error: getErrorMessage(err),
    });
    return null;
  }
}
