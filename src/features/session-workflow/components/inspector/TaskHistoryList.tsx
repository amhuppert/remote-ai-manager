"use client";

import { cn } from "@/lib/ui/cn";
import { formatInspectorTimestamp } from "./chrome";
import type { TaskHistoryView } from "./task-history";

/**
 * Tasks tab → Tasks → task history (§11): every attempt this task has been
 * through, not only its newest failure. A send-back is the interesting event —
 * it is why the context ran another iteration — so each one is stated with the
 * reason the validator gave.
 */

const entryLabel: Record<TaskHistoryView["entries"][number]["kind"], string> = {
  started: "started",
  rejected: "sent back",
  completed: "completed",
};

export default function TaskHistoryList({
  view,
}: {
  view: TaskHistoryView;
}): React.JSX.Element | null {
  if (!view.hasHistory) return null;

  return (
    <div className="mb-[10px]" data-testid="task-history">
      <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        History
        {view.reopenedCount > 0 ? (
          <span className="ml-[6px] font-normal text-blue normal-case">
            reopened {view.reopenedCount}×
          </span>
        ) : null}
      </span>
      <ul className="m-0 list-none border-x-0 border-y-0 border-l-2 border-solid border-border-default p-0 pl-[10px]">
        {view.entries.map((entry, index) => (
          <li
            key={`${entry.kind}-${entry.at}-${index}`}
            data-testid="task-history-entry"
            data-kind={entry.kind}
            className="py-[3px] font-mono text-[0.7rem] leading-[1.5]"
          >
            <span className="text-text-tertiary">
              {formatInspectorTimestamp(entry.at)}
            </span>{" "}
            <span
              className={cn(
                entry.kind === "rejected" ? "text-red" : "text-text-secondary",
              )}
            >
              {entryLabel[entry.kind]}
            </span>
            {entry.detail !== null ? (
              <span className="text-text-secondary"> — {entry.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
