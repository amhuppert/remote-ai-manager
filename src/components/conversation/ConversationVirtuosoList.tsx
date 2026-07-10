import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  computeRowKey,
  type ConversationRow,
} from "@/components/conversation/conversation-rows";

export const ConversationVirtuosoItem = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function ConversationVirtuosoItem({ className, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={
        className
          ? `conversation-virtuoso-item ${className}`
          : "conversation-virtuoso-item"
      }
    />
  );
});

export interface ConversationVirtuosoListProps {
  rows: readonly ConversationRow[];
  virtuosoRef: Ref<VirtuosoHandle>;
  conversationId: string;
  followBottom: boolean;
  renderMessage(args: {
    row: Extract<ConversationRow, { kind: "message" }>;
    isLast: boolean;
  }): ReactNode;
  renderCollab(args: {
    row: Extract<ConversationRow, { kind: "collab" }>;
  }): ReactNode;
  renderExtension?(args: {
    row: Extract<ConversationRow, { kind: "extension" }>;
  }): ReactNode;
  renderFooter(): ReactNode;
  onRangeChanged(range: { startIndex: number; endIndex: number }): void;
  onAtBottomStateChange(atBottom: boolean): void;
  onAtTopStateChange(atTop: boolean): void;
}

export function resolveConversationFollowOutput(
  isAtBottom: boolean,
  followBottom: boolean,
): "smooth" | false {
  return isAtBottom || followBottom ? "smooth" : false;
}

export default function ConversationVirtuosoList({
  rows,
  virtuosoRef,
  conversationId,
  followBottom,
  renderMessage,
  renderCollab,
  renderExtension,
  renderFooter,
  onRangeChanged,
  onAtBottomStateChange,
  onAtTopStateChange,
}: ConversationVirtuosoListProps) {
  return (
    <Virtuoso
      key={conversationId}
      ref={virtuosoRef}
      data={rows}
      initialTopMostItemIndex={{
        index: Math.max(0, rows.length - 1),
        align: "end",
      }}
      computeItemKey={(_index, row) => computeRowKey(row)}
      itemContent={(index, row) =>
        row.kind === "message"
          ? renderMessage({ row, isLast: index === rows.length - 1 })
          : row.kind === "collab"
            ? renderCollab({ row })
            : (renderExtension?.({ row }) ?? null)
      }
      followOutput={(isAtBottom) =>
        resolveConversationFollowOutput(isAtBottom, followBottom)
      }
      atBottomThreshold={4}
      components={{ Footer: renderFooter, Item: ConversationVirtuosoItem }}
      rangeChanged={onRangeChanged}
      atBottomStateChange={onAtBottomStateChange}
      atTopStateChange={onAtTopStateChange}
      style={{ height: "100%", flex: 1, minHeight: 0 }}
    />
  );
}

export type { VirtuosoHandle };
