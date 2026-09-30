/**
 * The SDK message a native Claude fork keeps through (`forkSession`'s
 * inclusive `upToMessageId`), read from the fork's transcript snapshot — the
 * copied prefix of the source through the visible fork point.
 *
 * The Claude adapter stamps each SDK assistant message's uuid on its
 * transcript frame. When the snapshot ends in an assistant message, the cut is
 * that message's last anchored line; an assistant message with no anchored
 * line has no exact cut, and cutting at an earlier anchor would drop a turn the
 * copied history shows, so there is no anchor. When the snapshot ends in a user
 * or notice message, the cut is the last anchored assistant line before it.
 */

import type { LineClassification } from "@/lib/conversations/transcript-logical-units";

export function selectClaudeForkAnchor(
  lines: Iterable<LineClassification>,
): string | null {
  let lastAnchor: string | null = null;
  let lastUnitIndex = -1;
  let lastUnitIsAssistant = false;
  let lastUnitAnchor: string | null = null;

  for (const line of lines) {
    if (!line.visible) continue;
    if (line.mergedIndex !== lastUnitIndex) {
      lastUnitIndex = line.mergedIndex;
      lastUnitIsAssistant = line.role === "assistant";
      lastUnitAnchor = null;
    }
    if (line.role === "assistant" && line.uuid) {
      lastAnchor = line.uuid;
      lastUnitAnchor = line.uuid;
    }
  }

  return lastUnitIsAssistant ? lastUnitAnchor : lastAnchor;
}
