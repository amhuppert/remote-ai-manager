import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  computeRowKey,
  type ConversationRow,
} from "@/components/conversation/conversation-rows";

const logger = createClientLogger("conversation-virtualization");

export const ConversationVirtuosoItem = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function ConversationVirtuosoItem({ className, style, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      // Margins must stay inside the measured box. Async or surface-supplied
      // content may be empty, but Virtuoso requires a positive item height.
      style={{ ...style, display: "flow-root", minHeight: 1 }}
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
  followBottom: boolean,
): "auto" | false {
  // Streaming can change the target on every frame; animated following
  // competes with Virtuoso's dynamic-height scroll corrections.
  return followBottom ? "auto" : false;
}

export function shouldStopConversationFollow(
  previousTop: number,
  top: number,
  previousHeight: number,
  height: number,
  viewport: number,
): boolean {
  return (
    height === previousHeight &&
    top < previousTop &&
    height - viewport - top > 4
  );
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
  const listRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(followBottom);
  const resizeFrameRef = useRef<number | null>(null);
  const detachScrollRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    followingRef.current = followBottom;
  }, [followBottom]);
  useEffect(
    () => () => {
      detachScrollRef.current?.();
      if (resizeFrameRef.current !== null)
        cancelAnimationFrame(resizeFrameRef.current);
    },
    [],
  );
  const captureScroller = useCallback(
    (element: HTMLElement | Window | null) => {
      detachScrollRef.current?.();
      const scroller = element instanceof HTMLElement ? element : null;
      scrollerRef.current = scroller;
      if (!scroller) return;
      let pointerDown = false;
      let touchY = 0;
      const pause = () => {
        if (!followingRef.current) return;
        followingRef.current = false;
        onAtBottomStateChange(false);
        logger.debug("conversation.scroll.follow_paused", {
          conversationId,
          top: scroller.scrollTop,
        });
      };
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY < 0 && scroller.scrollTop > 0) pause();
      };
      const onTouchStart = (event: TouchEvent) => {
        touchY = event.touches[0]?.clientY ?? 0;
      };
      const onTouchMove = (event: TouchEvent) => {
        const nextY = event.touches[0]?.clientY ?? touchY;
        if (nextY > touchY && scroller.scrollTop > 0) pause();
        touchY = nextY;
      };
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target;
        if (
          scroller.scrollTop === 0 ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        )
          return;
        if (
          ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey)
        )
          pause();
      };
      const onPointerDown = (event: PointerEvent) => {
        pointerDown = true;
        if (event.target === scroller) pause();
      };
      const onPointerUp = () => {
        if (!pointerDown) return;
        pointerDown = false;
        if (
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <=
          4
        ) {
          followingRef.current = true;
          onAtBottomStateChange(true);
        }
      };
      let previousTop = scroller.scrollTop;
      let previousHeight = scroller.scrollHeight;
      const onScroll = () => {
        const top = scroller.scrollTop;
        const height = scroller.scrollHeight;
        if (
          pointerDown &&
          shouldStopConversationFollow(
            previousTop,
            top,
            previousHeight,
            height,
            scroller.clientHeight,
          )
        ) {
          pause();
        }
        previousTop = top;
        previousHeight = height;
      };
      scroller.addEventListener("scroll", onScroll, { passive: true });
      scroller.addEventListener("wheel", onWheel, { passive: true });
      scroller.addEventListener("touchstart", onTouchStart, { passive: true });
      scroller.addEventListener("touchmove", onTouchMove, { passive: true });
      scroller.addEventListener("keydown", onKeyDown);
      scroller.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      detachScrollRef.current = () => {
        scroller.removeEventListener("scroll", onScroll);
        scroller.removeEventListener("wheel", onWheel);
        scroller.removeEventListener("touchstart", onTouchStart);
        scroller.removeEventListener("touchmove", onTouchMove);
        scroller.removeEventListener("keydown", onKeyDown);
        scroller.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };
    },
    [conversationId, onAtBottomStateChange],
  );
  useImperativeHandle(virtuosoRef, () => {
    const handle = listRef.current!;
    return {
      ...handle,
      scrollToIndex(location) {
        const following =
          typeof location === "object" && location.index === "LAST";
        followingRef.current = following;
        onAtBottomStateChange(following);
        handle.scrollToIndex(location);
      },
    };
  }, [conversationId, onAtBottomStateChange]);
  const handleHeightChanged = useCallback(() => {
    if (resizeFrameRef.current !== null)
      cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      const scroller = scrollerRef.current;
      const behavior = resolveConversationFollowOutput(followingRef.current);
      if (!scroller || !behavior) return;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    });
  }, []);
  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      // Growth can temporarily move the bottom away from a stationary viewport.
      // Only an upward scroll disengages following; reaching the end restores it.
      if (!atBottom) return;
      followingRef.current = true;
      onAtBottomStateChange(true);
      logger.debug("conversation.scroll.bottom_reached", { conversationId });
    },
    [conversationId, onAtBottomStateChange],
  );

  return (
    <Virtuoso
      key={conversationId}
      ref={listRef}
      scrollerRef={captureScroller}
      totalListHeightChanged={handleHeightChanged}
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
      // Follow after layout without queuing Virtuoso scroll retries that could
      // outlive the reader's gesture to leave the bottom.
      followOutput={false}
      atBottomThreshold={4}
      components={{ Footer: renderFooter, Item: ConversationVirtuosoItem }}
      rangeChanged={onRangeChanged}
      atBottomStateChange={handleAtBottomStateChange}
      atTopStateChange={onAtTopStateChange}
      style={{ height: "100%", flex: 1, minHeight: 0 }}
    />
  );
}

export type { VirtuosoHandle };
