"use client";

import Link from "next/link";
import { useMemo } from "react";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { TranscriptExtensions } from "@/components/conversation/ConversationTranscript";
import type { TranscriptExtensionRowData } from "@/components/conversation/conversation-rows";
import {
  graphWorkflowLaunchReceiptSchema,
  type GraphWorkflowLaunchReceipt,
} from "@/lib/workflow-graph/schemas";
import {
  useGraphWorkflowExecutionByIdQuery,
  useGraphWorkflowLatestExecutionResultQuery,
} from "@/lib/workflows/queries";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { Badge } from "@/components/ui/Badge";
import {
  originFallbackName,
  originKindLabel,
} from "@/lib/workflow-graph/execution-origin";

export interface WorkflowReceiptCardRow extends TranscriptExtensionRowData {
  kind: "workflow-receipt-card";
  receipt: GraphWorkflowLaunchReceipt;
}

interface ReceiptProjection {
  rows: WorkflowReceiptCardRow[];
  hiddenResultBlocks: Set<string>;
}

const STATUS_TONE: Record<string, StatusChipTone> = {
  pending: "neutral",
  awaiting_definition_approval: "amber",
  running: "cyan",
  paused: "amber",
  completed: "green",
  halted: "red",
  aborted: "neutral",
};

function isLaunchTool(name: string, input: unknown): boolean {
  if (
    name === "start_graph_workflow" ||
    name.endsWith("__start_graph_workflow")
  ) {
    return true;
  }
  if (name !== "Bash" || typeof input !== "object" || input === null) {
    return false;
  }

  const command = (input as Record<string, unknown>).command;
  return (
    typeof command === "string" &&
    /^cctl\s+workflow\s+(?:run|start)(?:\s|$)/.test(command.trim())
  );
}

function parseReceipt(
  value: unknown,
  depth = 0,
): GraphWorkflowLaunchReceipt | null {
  if (depth > 5) return null;
  const direct = graphWorkflowLaunchReceiptSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    try {
      return parseReceipt(JSON.parse(trimmed), depth + 1);
    } catch {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
      if (fenced !== undefined) return parseReceipt(fenced, depth + 1);
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseReceipt(entry, depth + 1);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["receipt", "data", "result", "content", "text"]) {
    if (!(key in record)) continue;
    const parsed = parseReceipt(record[key], depth + 1);
    if (parsed !== null) return parsed;
  }
  return null;
}

function projectWorkflowReceiptTurns(
  messages: readonly TranscriptMessage[],
  conversationId: string,
): ReceiptProjection {
  const launchToolIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (
        block.type === "tool_use" &&
        block.id !== undefined &&
        isLaunchTool(block.name, block.input)
      ) {
        launchToolIds.add(block.id);
      }
    }
  }

  const rows: WorkflowReceiptCardRow[] = [];
  const hiddenResultBlocks = new Set<string>();
  const seenExecutionIds = new Set<string>();
  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex];
    if (message === undefined) continue;
    for (
      let blockIndex = 0;
      blockIndex < message.content.length;
      blockIndex += 1
    ) {
      const block = message.content[blockIndex];
      if (
        block?.type !== "tool_result" ||
        block.isError === true ||
        !launchToolIds.has(block.tool_use_id)
      ) {
        continue;
      }
      const receipt = parseReceipt(block.content);
      if (receipt === null || receipt.originConversationId !== conversationId) {
        continue;
      }
      hiddenResultBlocks.add(`${messageIndex}:${blockIndex}`);
      if (seenExecutionIds.has(receipt.executionId)) continue;
      seenExecutionIds.add(receipt.executionId);
      rows.push({
        key: `workflow-receipt:${receipt.executionId}`,
        anchorMessageIndex: messageIndex,
        kind: "workflow-receipt-card",
        receipt,
      });
    }
  }
  return { rows, hiddenResultBlocks };
}

export function deriveWorkflowReceiptCardRows(
  messages: readonly TranscriptMessage[],
  conversationId: string,
): WorkflowReceiptCardRow[] {
  return projectWorkflowReceiptTurns(messages, conversationId).rows;
}

export function stripWorkflowReceiptToolResults(
  content: readonly MessageContentBlock[],
  messageIndex: number,
  messages: readonly TranscriptMessage[],
  conversationId: string,
): MessageContentBlock[] {
  const projection = projectWorkflowReceiptTurns(messages, conversationId);
  return content.filter(
    (_block, blockIndex) =>
      !projection.hiddenResultBlocks.has(`${messageIndex}:${blockIndex}`),
  );
}

export function useWorkflowReceiptTranscriptExtensions(input: {
  projectName: string;
  sessionName: string;
  conversationId: string;
}): TranscriptExtensions {
  return useMemo(() => {
    const project = (messages: readonly TranscriptMessage[]) =>
      projectWorkflowReceiptTurns(messages, input.conversationId);

    return {
      deriveRows(messages) {
        return project(messages).rows;
      },
      transformContent(content, messageIndex, messages) {
        const hidden = project(messages).hiddenResultBlocks;
        return content.filter(
          (_block, blockIndex) => !hidden.has(`${messageIndex}:${blockIndex}`),
        );
      },
      render(row: WorkflowReceiptCardRow) {
        return (
          <WorkflowReceiptCard
            projectName={input.projectName}
            sessionName={input.sessionName}
            receipt={row.receipt}
          />
        );
      },
    };
  }, [input.conversationId, input.projectName, input.sessionName]);
}

export default function WorkflowReceiptCard({
  projectName,
  sessionName,
  receipt,
}: {
  projectName: string;
  sessionName: string;
  receipt: GraphWorkflowLaunchReceipt;
}) {
  const executionQuery = useGraphWorkflowExecutionByIdQuery(
    projectName,
    sessionName,
    receipt.executionId,
  );
  const resultQuery = useGraphWorkflowLatestExecutionResultQuery(
    projectName,
    sessionName,
    receipt.executionId,
  );
  const execution = executionQuery.data ?? null;
  const status = execution?.status ?? receipt.status;
  const name =
    execution?.launchDocument?.name ?? originFallbackName(receipt.origin);
  const description = execution?.launchDocument?.description ?? null;
  const href = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/workflow?execution=${encodeURIComponent(receipt.executionId)}`;

  return (
    <Link
      href={href}
      aria-label={`Open workflow execution ${receipt.executionId}`}
      className="mx-lg my-sm flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-inherit no-underline transition-colors duration-150 hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:mx-sm"
    >
      <span className="flex min-w-0 items-center gap-sm">
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78rem] font-semibold text-text-primary">
          {name}
        </span>
        <StatusChip tone={STATUS_TONE[status] ?? "neutral"}>
          {status}
        </StatusChip>
      </span>
      <span className="flex flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
        <Badge tier="count">{originKindLabel(receipt.origin)}</Badge>
        <span>{receipt.executionId}</span>
        {resultQuery.data !== null && resultQuery.data !== undefined && (
          <span>{resultQuery.data.boundaryKind} result recorded</span>
        )}
      </span>
      {description !== null && (
        <span className="line-clamp-2 text-[0.74rem] text-text-secondary">
          {description}
        </span>
      )}
    </Link>
  );
}
