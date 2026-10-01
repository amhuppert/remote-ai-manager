import type { QueuedMessageMetadata } from "./message-queue-schemas";
import type { TranscriptMessage } from "./schemas";

/** Machine provenance, never XML spelling, decides what the transcript shows. */
export function subscriptionMessagePresentation(
  message: TranscriptMessage,
  queuedMetadata?: QueuedMessageMetadata | null,
) {
  const batchIds = new Set<string>();
  if (queuedMetadata?.kind === "subscription_update") {
    batchIds.add(queuedMetadata.batchId);
  }
  if (message.origin?.source === "subscription_update") {
    const batchId = message.origin.subscriptionUpdate?.batchId;
    if (batchId) batchIds.add(batchId);
  }
  const machineParts = (message.sourceParts ?? []).filter(
    (part) => part.origin?.source === "subscription_update",
  );
  for (const part of machineParts) {
    const batchId = part.origin?.subscriptionUpdate?.batchId;
    if (batchId) batchIds.add(batchId);
  }

  const machineOnly =
    queuedMetadata?.kind === "subscription_update" ||
    message.origin?.source === "subscription_update" ||
    (machineParts.length > 0 &&
      machineParts.length === message.sourceParts?.length);
  const ranges = machineParts.flatMap((part) =>
    part.contentRange ? [part.contentRange] : [],
  );
  const content = machineOnly
    ? []
    : ranges.length > 0
      ? message.content.filter(
          (_block, index) =>
            !ranges.some((range) => index >= range.start && index < range.end),
        )
      : message.content;
  const hiddenContentIndexes = new Set<number>();
  for (let index = 0; index < message.content.length; index++) {
    if (
      machineOnly ||
      ranges.some((range) => index >= range.start && index < range.end)
    )
      hiddenContentIndexes.add(index);
  }
  return { content, hiddenContentIndexes, subscriptionBatchIds: [...batchIds] };
}

/** Preserve display provenance while SSE keeps the canonical merged index. */
export function mergedSubscriptionMessageProvenance(
  previous: TranscriptMessage & { seq: number },
  incoming: TranscriptMessage & { seq: number },
): Pick<TranscriptMessage, "origin" | "sourceParts"> {
  const isSubscription = (message: TranscriptMessage) =>
    message.origin?.source === "subscription_update" ||
    message.sourceParts?.some(
      (part) => part.origin?.source === "subscription_update",
    );
  if (!isSubscription(previous) && !isSubscription(incoming)) return {};

  const parts = (message: TranscriptMessage & { seq: number }) =>
    message.sourceParts ?? [
      {
        seq: message.seq,
        ...(message.origin ? { origin: message.origin } : {}),
        contentRange: { start: 0, end: message.content.length },
      },
    ];
  const offset = previous.content.length;
  return {
    origin:
      previous.origin &&
      JSON.stringify(previous.origin) === JSON.stringify(incoming.origin)
        ? previous.origin
        : undefined,
    sourceParts: [
      ...parts(previous),
      ...parts(incoming).map((part) => ({
        ...part,
        ...(part.contentRange
          ? {
              contentRange: {
                start: part.contentRange.start + offset,
                end: part.contentRange.end + offset,
              },
            }
          : {}),
      })),
    ],
  };
}
