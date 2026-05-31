import type { NotificationItem } from "./NotificationsPanel";
import { assertNever } from "@/lib/shared/assert-never";

export function getItemLabel(item: NotificationItem): string {
  switch (item.type) {
    case "conversation": {
      const status = item.status;
      switch (status) {
        case "running":
          return "Running";
        case "awaiting":
          return "Awaiting";
        case "new":
          return "New";
        case "waiting_for_input":
          return "Needs input";
        default:
          return assertNever(status);
      }
    }
    case "merge": {
      const status = item.status;
      switch (status) {
        case "running":
          if (item.phase === "validating" || item.phase === "re-validating")
            return "Validating...";
          if (item.phase === "fixing-validation") return "Fixing errors...";
          if (item.phase === "preparing") return "Preparing merge...";
          if (item.phase === "publishing") return "Publishing...";
          if (item.phase === "squash-merging") return "Finalizing...";
          return "Merging...";
        case "success":
          return "Merged";
        case "conflicts":
          return `${item.conflictCount ?? 0} conflict${(item.conflictCount ?? 0) !== 1 ? "s" : ""}`;
        case "error":
          return "Merge failed";
        case "ready-to-land":
          return "Awaiting clean target...";
        case "discarded":
          return "Discarded";
        default:
          return assertNever(status);
      }
    }
    case "commit": {
      const status = item.status;
      switch (status) {
        case "running":
          if (item.phase === "validating" || item.phase === "re-validating")
            return "Validating...";
          if (item.phase === "fixing-validation") return "Fixing errors...";
          return "Committing...";
        case "success":
          return "Committed";
        case "error":
          return "Commit failed";
        default:
          return assertNever(status);
      }
    }
    case "resolve-conflicts": {
      const status = item.status;
      switch (status) {
        case "running":
          return "Resolving...";
        case "success":
          return "Resolved";
        case "error":
          return "Resolution failed";
        default:
          return assertNever(status);
      }
    }
    case "graph-workflow":
      return `${item.completedContexts}/${item.totalContexts}`;
    default:
      return assertNever(item);
  }
}
