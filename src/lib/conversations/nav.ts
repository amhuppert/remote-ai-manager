// Pure helpers for conversation message navigation. Extracted from
// ConversationDetailPage so the navigation logic can be unit tested without
// rendering the full page component or a virtualized scroll surface.

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
