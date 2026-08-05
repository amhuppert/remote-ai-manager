import { z } from "zod";
import { getContextArtifactsRepo } from "@/lib/context-artifacts/route-handlers";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import { createLogger } from "@/lib/logging";
import { readTranscriptEntriesWithSeq } from "@/lib/prompt/transcript";
import {
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
} from "./transcript-render";

export const CONVERSATION_NAMING_CONTEXT_MAX_BYTES = 24_576;
export const MESSAGE_NAMING_CONTEXT_MAX_BYTES = 16_384;

const conversationNamingContentInputSchema = z.object({
  conversationId: z.string(),
  transcriptPath: z.string().nullable(),
});

const messageNamingContentInputSchema = z.object({
  transcriptPath: z.string().nullable(),
  messageIndex: z.number().int().nonnegative(),
});

export type ConversationNamingContentInput = z.infer<
  typeof conversationNamingContentInputSchema
>;
export type MessageNamingContentInput = z.infer<
  typeof messageNamingContentInputSchema
>;

export interface NamingContextDeps {
  findArtifacts(conversationId: string): ContextArtifactRow[];
}

const logger = createLogger("conversation-naming");

function productionDeps(): NamingContextDeps {
  return {
    findArtifacts(conversationId) {
      return getContextArtifactsRepo().findByConversation(conversationId);
    },
  };
}

function findFreshConversationArtifact(
  artifacts: ContextArtifactRow[],
  maxSeq: number,
): ContextArtifactRow | null {
  return (
    artifacts.find(
      (artifact) =>
        artifact.kind === "conversation_compaction" &&
        artifact.status === "complete" &&
        artifact.payload !== null &&
        artifact.coveredEndSeq >= maxSeq,
    ) ?? null
  );
}

export async function resolveConversationNamingContent(
  rawInput: ConversationNamingContentInput,
  deps: NamingContextDeps = productionDeps(),
): Promise<string | null> {
  const parsed = conversationNamingContentInputSchema.safeParse(rawInput);
  if (!parsed.success || parsed.data.transcriptPath === null) return null;
  const input = parsed.data;
  const transcript = await readTranscriptEntriesWithSeq(input.transcriptPath);
  if (transcript.entries.length === 0) {
    logger.info("conversation_naming.context_resolved", {
      conversationId: input.conversationId,
      source: "none",
    });
    return null;
  }

  const artifact = findFreshConversationArtifact(
    deps.findArtifacts(input.conversationId),
    transcript.maxSeq,
  );
  if (artifact?.payload !== null && artifact?.payload !== undefined) {
    logger.info("conversation_naming.context_resolved", {
      conversationId: input.conversationId,
      source: "compaction",
      coveredEndSeq: artifact.coveredEndSeq,
      maxSeq: transcript.maxSeq,
    });
    return compactionEnvelopeToMarkdown(artifact.payload, {
      stale: false,
      staleBehindMessages: 0,
      outdated: false,
      updatedAt: artifact.updatedAt,
    });
  }

  const rendered = renderCompactTranscript(
    {
      conversationId: input.conversationId,
      entries: transcript.entries,
      maxSeq: transcript.maxSeq,
    },
    renderOptionsSchema.parse({
      includeTools: "summary",
      includeThinking: false,
      maxBytes: CONVERSATION_NAMING_CONTEXT_MAX_BYTES,
    }),
  );
  logger.info("conversation_naming.context_resolved", {
    conversationId: input.conversationId,
    source: "transcript",
    truncated: rendered.truncated,
    maxSeq: transcript.maxSeq,
  });
  return renderedTranscriptToMarkdown(rendered);
}

export async function resolveMessageNamingContent(
  rawInput: MessageNamingContentInput,
): Promise<string | null> {
  const parsed = messageNamingContentInputSchema.safeParse(rawInput);
  if (!parsed.success || parsed.data.transcriptPath === null) return null;
  const input = parsed.data;
  const transcript = await readTranscriptEntriesWithSeq(input.transcriptPath);
  if (transcript.entries.length === 0) return null;

  const rendered = renderCompactTranscript(
    {
      conversationId: "message-naming-context",
      entries: transcript.entries,
      maxSeq: transcript.maxSeq,
    },
    renderOptionsSchema.parse({
      messageRange: [input.messageIndex, input.messageIndex],
      includeTools: "none",
      includeThinking: false,
      maxBytes: MESSAGE_NAMING_CONTEXT_MAX_BYTES,
    }),
  );
  if (rendered.units.length === 0) return null;

  logger.info("conversation_naming.message_context_resolved", {
    messageIndex: input.messageIndex,
    truncated: rendered.truncated,
    maxSeq: transcript.maxSeq,
  });
  return renderedTranscriptToMarkdown(rendered);
}
