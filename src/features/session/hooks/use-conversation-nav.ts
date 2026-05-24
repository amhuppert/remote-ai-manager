"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  computeCurrentMessageIndex,
  getNextMessageIndex,
  getPrevMessageIndex,
  type ScrollEdgePosition,
} from "@/lib/conversations/nav";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import {
  topmostMessageIndexForRange,
  type ConversationRow,
} from "@/features/session/conversation/conversation-rows";
import type {
  ConversationVirtuosoListProps,
  VirtuosoHandle,
} from "@/features/session/conversation/ConversationVirtuosoList";

export interface UseConversationNavArgs {
  rows: ConversationRow[];
  totalMessages: number;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

export interface UseConversationNavResult {
  currentMessageIndex: number;
  handleRangeChanged: ConversationVirtuosoListProps["onRangeChanged"];
  handleAtBottomStateChange: ConversationVirtuosoListProps["onAtBottomStateChange"];
  handleAtTopStateChange: ConversationVirtuosoListProps["onAtTopStateChange"];
  handleFirstMessage: () => void;
  handlePrevMessage: () => void;
  handleNextMessage: () => void;
  handleLastMessage: () => void;
}

const PROGRAMMATIC_HOLD_MS = 1500;

// --- Scroll-derived navigation state ---
// `currentMessageIndex` is computed from the actual scroll position so the
// counter always reflects what the user sees. Virtuoso reports row ranges
// and edge transitions, while message navigation remains message-index based.
export function useConversationNav({
  rows,
  totalMessages,
  virtuosoRef,
}: UseConversationNavArgs): UseConversationNavResult {
  const programmaticNavTargetRef = useRef<number | null>(null);
  const clearProgrammaticNavTargetRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (clearProgrammaticNavTargetRef.current) {
        clearTimeout(clearProgrammaticNavTargetRef.current);
      }
    };
  }, []);

  const holdProgrammaticNavTarget = useCallback((messageIndex: number) => {
    programmaticNavTargetRef.current = messageIndex;
    if (clearProgrammaticNavTargetRef.current) {
      clearTimeout(clearProgrammaticNavTargetRef.current);
    }
    clearProgrammaticNavTargetRef.current = setTimeout(() => {
      programmaticNavTargetRef.current = null;
      clearProgrammaticNavTargetRef.current = null;
    }, PROGRAMMATIC_HOLD_MS);
  }, []);

  const [navState, setNavState] = useState<{
    topmostMessageIndex: number;
    edgePosition: ScrollEdgePosition;
    atBottom: boolean;
    atTop: boolean;
  }>({
    topmostMessageIndex: 0,
    edgePosition: "top",
    atBottom: false,
    atTop: true,
  });

  const handleRangeChanged = useCallback(
    ({ startIndex }: { startIndex: number; endIndex: number }) => {
      const topmostMessageIndex =
        programmaticNavTargetRef.current ??
        topmostMessageIndexForRange(rows, startIndex);
      setNavState((prev) =>
        prev.topmostMessageIndex === topmostMessageIndex
          ? prev
          : { ...prev, topmostMessageIndex },
      );
    },
    [rows],
  );

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setNavState((prev) =>
      prev.atBottom === atBottom
        ? prev
        : {
            ...prev,
            atBottom,
            edgePosition: atBottom ? "bottom" : prev.atTop ? "top" : "middle",
          },
    );
  }, []);

  const handleAtTopStateChange = useCallback((atTop: boolean) => {
    setNavState((prev) =>
      prev.atTop === atTop
        ? prev
        : {
            ...prev,
            atTop,
            edgePosition: prev.atBottom ? "bottom" : atTop ? "top" : "middle",
          },
    );
  }, []);

  const currentMessageIndex = useMemo(
    () =>
      computeCurrentMessageIndex({
        topmostMessageIndex: navState.topmostMessageIndex,
        edgePosition: navState.edgePosition,
        totalMessages,
      }),
    [navState, totalMessages],
  );

  const scrollToMessage = useCallback(
    (messageIdx: number) => {
      const clamped = Math.max(0, Math.min(messageIdx, totalMessages - 1));
      const rowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.messageIndex === clamped,
      );
      if (rowIndex === -1) return;
      holdProgrammaticNavTarget(clamped);
      setNavState((prev) => ({
        ...prev,
        topmostMessageIndex: clamped,
        edgePosition: clamped === 0 ? "top" : "middle",
        atTop: clamped === 0,
        atBottom: false,
      }));
      virtuosoRef.current?.scrollToIndex({
        index: rowIndex,
        align: "start",
        behavior: "smooth",
      });
    },
    [totalMessages, holdProgrammaticNavTarget, rows, virtuosoRef],
  );

  const scrollToTop = useCallback(() => {
    holdProgrammaticNavTarget(0);
    virtuosoRef.current?.scrollToIndex({
      index: 0,
      align: "start",
      behavior: "smooth",
    });
  }, [holdProgrammaticNavTarget, virtuosoRef]);

  const scrollToBottom = useCallback(
    (behavior: "auto" | "smooth" = "smooth") => {
      holdProgrammaticNavTarget(Math.max(0, totalMessages - 1));
      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior,
      });
    },
    [totalMessages, holdProgrammaticNavTarget, virtuosoRef],
  );

  const handleFirstMessage = useCallback(() => {
    if (totalMessages === 0) return;
    scrollToTop();
  }, [totalMessages, scrollToTop]);

  const handleLastMessage = useCallback(() => {
    if (totalMessages === 0) return;
    scrollToBottom();
  }, [totalMessages, scrollToBottom]);

  const handlePrevMessage = useCallback(() => {
    const target = getPrevMessageIndex({ currentIndex: currentMessageIndex });
    if (target === null) return;
    if (target === 0) {
      scrollToTop();
    } else {
      scrollToMessage(target);
    }
  }, [currentMessageIndex, scrollToMessage, scrollToTop]);

  const handleNextMessage = useCallback(() => {
    const target = getNextMessageIndex({
      currentIndex: currentMessageIndex,
      totalMessages,
    });
    if (target === null) return;
    if (target === totalMessages - 1) {
      scrollToBottom();
    } else {
      scrollToMessage(target);
    }
  }, [currentMessageIndex, totalMessages, scrollToMessage, scrollToBottom]);

  useAppHotkey("nextMessage", handleNextMessage);
  useAppHotkey("prevMessage", handlePrevMessage);
  useAppHotkey("firstMessage", handleFirstMessage);
  useAppHotkey("lastMessage", handleLastMessage);

  return {
    currentMessageIndex,
    handleRangeChanged,
    handleAtBottomStateChange,
    handleAtTopStateChange,
    handleFirstMessage,
    handlePrevMessage,
    handleNextMessage,
    handleLastMessage,
  };
}
