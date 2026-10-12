"use client";

import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { StatusChip } from "@/components/ui/StatusChip";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import type { ConversationBackgroundActivity } from "@/lib/conversations/schemas";

interface BackgroundActivityIndicatorProps {
  /** The conversation's live background-task set; null when nothing is running. */
  activity: ConversationBackgroundActivity | null;
  /**
   * Custody holds the agent's runtime between turns (design C5b §5): work is
   * owed even when no task is visible, such as a continuation or a reply to a
   * message sent while the agent worked.
   */
  custody?: boolean;
  /**
   * Whether the indicator may show at all. The parent suppresses it while a
   * turn streams — the typing indicator already says the agent is working, and
   * two "busy" affordances at once read as two separate activities.
   */
  visible: boolean;
}

// The typing indicator's pulsing dot, reused so background work reads as the
// same class of "still going" signal rather than a new visual language.
const dotClass =
  "block size-[6px] rounded-full bg-cyan animate-[typingBounce_1.2s_ease-in-out_infinite]";

/**
 * How often the relative timestamp re-renders. Matches the publish throttle:
 * the snapshot itself refreshes at most every few seconds, so a faster tick
 * would only re-render the same string.
 */
const TICK_MS = 5_000;

function primaryLabel(activity: ConversationBackgroundActivity): string {
  if (activity.tasks.length > 1) {
    return `${activity.tasks.length} background tasks`;
  }
  const task = activity.tasks[0]!;
  if (task.workflowName !== null) return `workflow ${task.workflowName}`;
  return task.description ?? task.subagentType ?? "background task";
}

/**
 * The freshness suffix. A task whose `lastActivityAt` still equals its
 * `startedAt` has produced no liveness proof yet, so claiming "last activity"
 * would overstate what is known — report the start instead. `task_progress`
 * cadence between turns is not guaranteed, and this is the graceful path when
 * it is sparse.
 */
function freshnessLabel(activity: ConversationBackgroundActivity): string {
  const hasProgress = activity.tasks.some(
    (task) => task.lastActivityAt !== task.startedAt,
  );
  if (hasProgress) {
    const latest = activity.tasks.reduce(
      (max, task) => (task.lastActivityAt > max ? task.lastActivityAt : max),
      activity.tasks[0]!.lastActivityAt,
    );
    return `last activity ${formatRelativeTime(latest)}`;
  }
  const earliest = activity.tasks.reduce(
    (min, task) => (task.startedAt < min ? task.startedAt : min),
    activity.tasks[0]!.startedAt,
  );
  return `started ${formatRelativeTime(earliest)}`;
}

/** What custody owes when no task is visible. */
const CUSTODY_LABEL = "agent still working between turns";

/**
 * "Something is still running in the background" for a conversation between
 * turns. Without it, harness background work (a Workflow-tool run, a
 * backgrounded shell, a subagent) is indistinguishable from a dead session:
 * the transcript simply stops.
 */
function BackgroundActivityIndicator({
  activity,
  custody = false,
  visible,
}: BackgroundActivityIndicatorProps): React.JSX.Element | null {
  const tasks =
    activity !== null && activity.tasks.length > 0 ? activity : null;
  const showing = visible && (tasks !== null || custody);
  // The snapshot's timestamps are fixed; only their distance from "now" moves,
  // so the tick just forces a re-render and the clock is read at render time.
  // The custody-only label has no time in it, so it needs no tick.
  const ticking = visible && tasks !== null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!showing) return null;

  return (
    <div className="flex animate-fade-in py-[4px] pr-0 pl-md">
      <StatusChip
        tone="cyan"
        appearance="flat"
        icon={<span className={cn(dotClass)} aria-hidden="true" />}
        data-testid="background-activity-indicator"
      >
        {tasks !== null
          ? `${primaryLabel(tasks)} · ${freshnessLabel(tasks)}`
          : CUSTODY_LABEL}
      </StatusChip>
    </div>
  );
}

export default memo(BackgroundActivityIndicator);
