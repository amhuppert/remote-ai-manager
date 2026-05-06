// Pure helpers for conversation message navigation. Extracted from
// ConversationDetailPage so the navigation logic can be unit tested without
// rendering the (very large) page component or mocking @tanstack/react-virtual.

import type { TranscriptMessage } from "@/types";

const EDGE_EPSILON = 4;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
}

export type ScrollEdgePosition = "top" | "middle" | "bottom";

export function classifyScrollPosition(
  metrics: ScrollMetrics,
): ScrollEdgePosition {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (scrollHeight <= clientHeight + EDGE_EPSILON) return "middle";
  if (scrollTop <= EDGE_EPSILON) return "top";
  if (scrollTop + clientHeight >= scrollHeight - EDGE_EPSILON) return "bottom";
  return "middle";
}

// Lowest-index item that is at least partially within the viewport: the one
// the user perceives as being "at the top" of what they see.
export function findTopmostVisibleItem(
  items: readonly VirtualItem[],
  scrollTop: number,
): VirtualItem | undefined {
  for (const item of items) {
    if (item.start + item.size > scrollTop) return item;
  }
  return items[items.length - 1];
}

export function computeCurrentMessageIndex(args: {
  topmostMessageIndex: number;
  edgePosition: ScrollEdgePosition;
  totalMessages: number;
}): number {
  const { topmostMessageIndex, edgePosition, totalMessages } = args;
  if (totalMessages <= 0) return 0;
  if (edgePosition === "bottom") return totalMessages - 1;
  if (edgePosition === "top") return 0;
  if (topmostMessageIndex < 0) return 0;
  if (topmostMessageIndex >= totalMessages) return totalMessages - 1;
  return topmostMessageIndex;
}

export function getNextMessageIndex(args: {
  currentIndex: number;
  totalMessages: number;
}): number | null {
  const next = args.currentIndex + 1;
  if (next >= args.totalMessages) return null;
  return next;
}

export function getPrevMessageIndex(args: {
  currentIndex: number;
}): number | null {
  if (args.currentIndex <= 0) return null;
  return args.currentIndex - 1;
}

// Initial size estimate for a virtualized conversation row. Used by
// `useVirtualizer.estimateSize` and as the floor for `measureElement` when no
// ResizeObserver entry is available yet. Block-aware so each row's first paint
// lands close to its true height — large undershoots cascade into a burst of
// synchronous re-measure reflows under react-virtual.
//
// Constants are coarse on purpose: a perfect estimate isn't the goal (the
// observer corrects whatever we return). What matters is that we never start
// from a flat 120px for a 1500px tool-output row.
const COLLAB_ROW_HEIGHT = 220;
const ROW_HEIGHT_FLOOR = 96;
const ROW_HEIGHT_CEIL = 800;
const TEXT_LINE_HEIGHT = 22;
const TEXT_CHARS_PER_WRAP = 80;
const TOOL_USE_HEIGHT = 96;
const TOOL_RESULT_BASE_HEIGHT = 80;
const TOOL_RESULT_LINE_HEIGHT = 18;
const IMAGE_BLOCK_HEIGHT = 240;
const COMMAND_BLOCK_HEIGHT = 60;
const ROLE_BAR_HEIGHT = 36;
const EMPTY_USER_FALLBACK = 64;
const EMPTY_ASSISTANT_FALLBACK = 96;

export type EstimateRowInput =
  | { kind: "collab" }
  | { kind: "message"; message: TranscriptMessage };

export function estimateVirtualRowSize(input: EstimateRowInput): number {
  if (input.kind === "collab") return COLLAB_ROW_HEIGHT;

  const { message } = input;
  let total = ROLE_BAR_HEIGHT;

  if (message.content.length === 0) {
    total +=
      message.role === "user" ? EMPTY_USER_FALLBACK : EMPTY_ASSISTANT_FALLBACK;
    return clamp(total);
  }

  for (const block of message.content) {
    switch (block.type) {
      case "text": {
        const text = block.text;
        const newlineCount = countChar(text, "\n");
        const wrappedLines = Math.ceil(text.length / TEXT_CHARS_PER_WRAP);
        const lines = Math.max(1, newlineCount + 1, wrappedLines);
        total += lines * TEXT_LINE_HEIGHT;
        break;
      }
      case "tool_use":
        total += TOOL_USE_HEIGHT;
        break;
      case "tool_result": {
        const content = block.content ?? "";
        const lines = countChar(content, "\n") + 1;
        total += TOOL_RESULT_BASE_HEIGHT + lines * TOOL_RESULT_LINE_HEIGHT;
        break;
      }
      case "image":
      case "image_ref":
      case "image_marker":
        total += IMAGE_BLOCK_HEIGHT;
        break;
      case "command":
        total += COMMAND_BLOCK_HEIGHT;
        break;
    }
  }

  return clamp(total);
}

function clamp(n: number): number {
  if (n < ROW_HEIGHT_FLOOR) return ROW_HEIGHT_FLOOR;
  if (n > ROW_HEIGHT_CEIL) return ROW_HEIGHT_CEIL;
  return n;
}

function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}
