"use client";

import { memo, useMemo } from "react";
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import type { QueuedMessageMetadata } from "@/lib/conversations/message-queue-schemas";
import {
  formatToolUse,
  type FormattedToolUse,
} from "@/lib/conversations/format-tool-use";
import {
  groupContentBlocks,
  type MessagePartRange,
} from "@/lib/conversations/group-content-blocks";
import { cn } from "@/lib/ui/cn";
import ToolUseGroup from "./ToolUseGroup";
import ThinkingBlock, {
  type ThinkingBlockExpansionCommand,
} from "./ThinkingBlock";
import DebugStructuredCard from "./DebugStructuredCard";
import DocumentFeedbackCard from "./conversation/DocumentFeedbackCard";
import NotepadFeedbackCard from "./conversation/NotepadFeedbackCard";
import MarkdownFileCard from "./conversation/MarkdownFileCard";
import QuestionAnswersCard from "./conversation/QuestionAnswersCard";
import CommandIndicator from "./CommandIndicator";
import { extractMarkdownFileRefs } from "@/lib/documents/markdown-file-refs";
import { splitQuestionAnswersBlock } from "@/lib/conversations/question-answers-block";
import { MessageTextWithRefs } from "@/features/session/conversation/MessageTextWithRefs";

export interface ToolResultLookup {
  get(
    toolUseId: string | undefined,
  ): { isError?: boolean; metrics?: ToolResultMetrics } | undefined;
}

/** Build a lookup from tool_use.id → its paired tool_result metadata. */
export function buildToolResultLookup(
  blocks: MessageContentBlock[],
): ToolResultLookup {
  const map = new Map<
    string,
    { isError?: boolean; metrics?: ToolResultMetrics }
  >();
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    map.set(block.tool_use_id, {
      ...(block.isError !== undefined ? { isError: block.isError } : {}),
      ...(block.metrics ? { metrics: block.metrics } : {}),
    });
  }
  return {
    get: (toolUseId) =>
      toolUseId === undefined ? undefined : map.get(toolUseId),
  };
}

/**
 * A single tool-use row. Rendered standalone in a message stream and, with
 * `nested`, inside a collapsed `ToolUseGroup` body (tighter margin, surface
 * background, no accent border).
 */
export function ToolUseIndicator({
  formatted,
  nested = false,
}: {
  formatted: FormattedToolUse;
  nested?: boolean;
}): React.JSX.Element {
  const { isError } = formatted;
  return (
    <div
      className={cn(
        "flex min-h-[30px] flex-wrap items-center gap-[6px] rounded-sm border-y-0 border-r-0 border-solid px-sm py-[6px] font-mono text-[0.78rem]",
        nested
          ? "my-[2px] border-l-0 bg-bg-surface"
          : cn(
              "my-sm border-l-2 bg-bg-raised",
              isError ? "border-l-red" : "border-l-cyan-dim",
            ),
      )}
    >
      <span
        className={cn(
          "shrink-0 text-[0.85rem]",
          isError ? "text-red" : "text-cyan-dim",
        )}
      >
        {isError ? "✕" : "⚙"}
      </span>
      <span className="shrink-0 text-[0.75rem] font-semibold text-text-primary">
        {formatted.name}
      </span>
      {formatted.context && (
        <span className="min-w-0 overflow-hidden text-[0.72rem] font-normal text-ellipsis whitespace-nowrap text-text-tertiary">
          {formatted.context}
        </span>
      )}
      {formatted.metricsLabel && (
        <span
          className={cn(
            "ml-auto shrink-0 pl-sm text-[0.7rem] font-normal",
            isError ? "text-red" : "text-text-tertiary",
          )}
        >
          {formatted.metricsLabel}
        </span>
      )}
      {formatted.command && (
        <pre className="m-0 basis-full rounded-[3px] bg-bg-surface px-[8px] py-[6px] font-mono text-[0.72rem] leading-[1.4] break-words whitespace-pre-wrap text-text-secondary">
          {formatted.command}
        </pre>
      )}
    </div>
  );
}

interface Props {
  content: MessageContentBlock[];
  /** Session worktree path — used to display tool file paths as relative when nested. */
  worktreePath?: string;
  /**
   * Provenance tag of the queue row this message renders from. Omitted for
   * delivered transcript rows (no queue provenance survives delivery); `null`
   * for a queue row the user typed. For queue rows the tag — not the raw text
   * — decides structured rendering (docs/design/cc-cli/03 §3).
   */
  queuedMetadata?: QueuedMessageMetadata | null;
  thinkingExpansionCommand?: ThinkingBlockExpansionCommand;
  /**
   * Slice of the message's grouped content to render. The transcript splits a
   * message across virtualized rows, so each row draws only its own units and
   * only the final one draws the trailing file cards. Omit to render the whole
   * message (non-virtualized hosts).
   */
  part?: MessagePartRange;
}

export default memo(function MessageContent({
  content,
  worktreePath,
  queuedMetadata,
  thinkingExpansionCommand,
  part,
}: Props): React.JSX.Element {
  const grouped = useMemo(() => groupContentBlocks(content), [content]);
  const resultLookup = useMemo(() => buildToolResultLookup(content), [content]);
  // Surfaced from the whole message so the cards stay visible even when the
  // tool-uses that produced them are collapsed into a grouped rendering (4.x).
  const fileRefs = useMemo(() => extractMarkdownFileRefs(content), [content]);
  // Adjacency lookups below index the full grouped list, so a slice keeps its
  // absolute positions rather than being re-based to zero.
  const start = part ? Math.min(part.start, grouped.length) : 0;
  const end = part ? Math.min(part.end, grouped.length) : grouped.length;
  const isLastPart = part === undefined || part.index === part.count - 1;
  const visible = grouped.slice(start, end);

  return (
    <>
      {visible.map((item, offset) => {
        const idx = start + offset;
        if (item.kind === "tool_group") {
          return (
            <ToolUseGroup
              key={`tg-${item.startIndex}`}
              blocks={item.blocks}
              worktreePath={worktreePath}
              resultLookup={resultLookup}
            />
          );
        }
        if (item.kind === "thinking_group") {
          return (
            <ThinkingBlock
              key={`th-${item.startIndex}`}
              text={item.block.text}
              redacted={item.block.redacted}
              redactedCount={item.block.redacted ? 0 : item.block.redactedCount}
              expansionCommand={thinkingExpansionCommand}
            />
          );
        }

        const { block, index: i } = item;

        if (block.type === "text") {
          // An answer message carries the delimited <cc-question-answers>
          // block — render it as an answer card, with any coalesced prose
          // around it as ordinary text. A queue row renders the card only
          // when its provenance metadata marks it as answers; a delivered
          // transcript row (no queue provenance) falls back to the persisted
          // block itself.
          const isAnswerMessage =
            queuedMetadata === undefined ||
            queuedMetadata?.kind === "question_answers";
          const answerSplit = isAnswerMessage
            ? splitQuestionAnswersBlock(block.text)
            : null;
          if (answerSplit) {
            return (
              <div key={i}>
                {answerSplit.before && (
                  <MessageTextWithRefs text={answerSplit.before} />
                )}
                <QuestionAnswersCard block={answerSplit.block} />
                {answerSplit.after && (
                  <MessageTextWithRefs text={answerSplit.after} />
                )}
              </div>
            );
          }
          return <MessageTextWithRefs key={i} text={block.text} />;
        }
        if (block.type === "thinking") {
          return (
            <ThinkingBlock
              key={i}
              text={block.text}
              redacted={block.redacted}
              expansionCommand={thinkingExpansionCommand}
            />
          );
        }
        if (block.type === "command") {
          return (
            <CommandIndicator key={i} name={block.name} args={block.args} />
          );
        }
        if (block.type === "image") {
          // A caption (image_marker) immediately before its image collapses the
          // gap between them (legacy `.message-image-caption + .message-inline-image`).
          const prev = grouped[idx - 1];
          const afterCaption =
            prev?.kind === "block" && prev.block.type === "image_marker";
          return (
            // eslint-disable-next-line @next/next/no-img-element -- base64 data URLs
            <img
              key={i}
              src={`data:${block.mediaType};base64,${block.base64Data}`}
              alt="Attached image"
              className={cn(
                "my-sm block max-h-[400px] max-w-full rounded-sm",
                afterCaption && "mt-0",
              )}
            />
          );
        }
        if (block.type === "image_marker") {
          return (
            <span
              key={i}
              className="mt-sm mb-[2px] block font-mono text-[0.72rem] tracking-[0.04em] text-[var(--text-muted)]"
            >
              #{block.index}
            </span>
          );
        }
        if (block.type === "debug_structured") {
          return (
            <DebugStructuredCard
              key={i}
              phase={block.phase}
              payload={block.payload}
            />
          );
        }
        if (block.type === "document_feedback") {
          return <DocumentFeedbackCard key={i} items={block.items} />;
        }
        if (block.type === "notepad_feedback") {
          return (
            <NotepadFeedbackCard
              key={i}
              notepadName={block.notepadName}
              items={block.items}
            />
          );
        }
        if (block.type === "tool_use") {
          const formatted = formatToolUse(block.name, block.input, {
            worktreePath,
            result: resultLookup.get(block.id),
          });
          return <ToolUseIndicator key={i} formatted={formatted} />;
        }
        // tool_result blocks are not rendered standalone; their data is folded
        // into the paired tool_use indicator via resultLookup above.
        return null;
      })}
      {isLastPart &&
        fileRefs.map((fileRef) => (
          <MarkdownFileCard key={fileRef.docPath} fileRef={fileRef} />
        ))}
    </>
  );
});
