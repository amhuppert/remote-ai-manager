import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  BranchIcon,
  CopyIcon,
  ArchiveIcon,
  TrashIcon,
} from "@/components/icons";
import type { KebabItem } from "./KebabMenu";

export interface RowHandlers {
  onBranch: (s: SessionListItem) => void;
  onCopyBranch: (s: SessionListItem) => void;
  onArchive: (s: SessionListItem) => void;
  onDelete: (s: SessionListItem) => void;
}

export function buildRowActions(
  session: SessionListItem,
  handlers: RowHandlers,
): KebabItem[] {
  const items: KebabItem[] = [];
  const active = !session.finished;

  if (active) {
    items.push({
      label: "Branch from here",
      icon: <BranchIcon size={14} />,
      onClick: () => handlers.onBranch(session),
    });
    items.push("divider");
  }

  items.push({
    label: "Copy branch",
    icon: <CopyIcon size={14} />,
    onClick: () => handlers.onCopyBranch(session),
  });
  items.push("divider");
  items.push({
    label: session.archived ? "Unarchive" : "Archive",
    icon: <ArchiveIcon size={14} />,
    onClick: () => handlers.onArchive(session),
  });
  items.push({
    label: "Delete session",
    icon: <TrashIcon size={14} />,
    onClick: () => handlers.onDelete(session),
    danger: true,
  });

  return items;
}
