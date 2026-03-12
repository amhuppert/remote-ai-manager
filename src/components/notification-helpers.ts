import type { NotificationItem } from "./NotificationsPanel";

export function getItemLabel(item: NotificationItem): string {
  switch (item.type) {
    case "conversation":
      return item.status === "running"
        ? "Running"
        : item.status === "awaiting"
          ? "Awaiting"
          : item.status === "new"
            ? "New"
            : "Needs input";
    case "merge":
      if (item.status === "running") {
        if (item.phase === "validating" || item.phase === "re-validating")
          return "Validating...";
        if (item.phase === "fixing-validation") return "Fixing errors...";
        if (item.phase === "squash-merging") return "Finalizing...";
        return "Merging...";
      }
      return item.status === "success"
        ? "Merged"
        : item.status === "conflicts"
          ? `${item.conflictCount ?? 0} conflict${(item.conflictCount ?? 0) !== 1 ? "s" : ""}`
          : "Merge failed";
    case "commit":
      return item.status === "running"
        ? "Committing..."
        : item.status === "success"
          ? "Committed"
          : "Commit failed";
    case "resolve-conflicts":
      return item.status === "running"
        ? "Resolving..."
        : item.status === "success"
          ? "Resolved"
          : "Resolution failed";
    case "workflow": {
      const labels: Record<string, string> = {
        running: `${item.iterationCount}/${item.maxIterations}`,
        paused: "Paused",
        completed: "Complete",
        halted: "Halted",
        aborted: "Aborted",
      };
      return labels[item.status] ?? item.status;
    }
  }
}
