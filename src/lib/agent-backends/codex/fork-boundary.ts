/**
 * Where a native Codex fork may cut, read from the fork's transcript snapshot.
 *
 * The snapshot is the fork's copied transcript: an immutable prefix of the
 * source through the visible fork point. The runtime archives every app-server
 * frame there as a `codex_app_server` envelope before interpreting it, so a
 * source-thread `turn/completed` envelope marks a provider turn that had
 * reached a terminal state when the snapshot was taken. A native fork through
 * that turn (`thread/fork` with `lastTurnId`) carries exactly the source
 * thread's history at the fork point when no message follows the completion:
 * any later user or assistant line is provider-bearing material the cut would
 * drop or misplace, so it clears the candidate. CC notices never reach the
 * provider and are skipped.
 *
 * A phase-less agent message disqualifies its turn: the projector holds such a
 * message until after the turn's completion frame is archived, so a snapshot
 * can contain the completion without the visible text the provider turn holds.
 */

import { z } from "zod";

const providerBearingLineSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(z.unknown()).min(1),
});

const appServerEnvelopeSchema = z.object({
  type: z.literal("codex_app_server"),
  raw: z.object({ record: z.string() }),
});

const turnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    threadId: z.string(),
    turn: z.object({ id: z.string() }),
  }),
});

const agentMessageCompletedSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    threadId: z.string(),
    turnId: z.string(),
    item: z.object({
      type: z.literal("agentMessage"),
      phase: z.string().nullish(),
    }),
  }),
});

const PROJECTED_PHASES: ReadonlySet<string> = new Set([
  "commentary",
  "final_answer",
]);

function parseRecordedFrame(record: string): unknown {
  // Only the two lifecycle methods matter; skip parsing every other frame.
  if (
    !record.includes('"turn/completed"') &&
    !record.includes('"item/completed"')
  )
    return null;
  try {
    return JSON.parse(record);
  } catch {
    return null;
  }
}

/** The source turn a native fork may keep through, or null for no exact cut. */
export async function selectCodexForkTurn(
  records: AsyncIterable<unknown> | Iterable<unknown>,
  sourceThreadId: string,
): Promise<string | null> {
  let candidate: string | null = null;
  const phaselessTurns = new Set<string>();

  for await (const record of records) {
    if (providerBearingLineSchema.safeParse(record).success) {
      candidate = null;
      continue;
    }
    const envelope = appServerEnvelopeSchema.safeParse(record);
    if (!envelope.success) continue;
    const message = parseRecordedFrame(envelope.data.raw.record);

    const completed = turnCompletedSchema.safeParse(message);
    if (completed.success) {
      if (completed.data.params.threadId === sourceThreadId)
        candidate = completed.data.params.turn.id;
      continue;
    }
    const agentMessage = agentMessageCompletedSchema.safeParse(message);
    if (
      agentMessage.success &&
      agentMessage.data.params.threadId === sourceThreadId &&
      !PROJECTED_PHASES.has(agentMessage.data.params.item.phase ?? "")
    )
      phaselessTurns.add(agentMessage.data.params.turnId);
  }

  return candidate !== null && !phaselessTurns.has(candidate)
    ? candidate
    : null;
}
