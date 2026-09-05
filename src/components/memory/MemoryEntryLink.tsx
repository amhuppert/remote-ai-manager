"use client";

import Link from "next/link";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  useMemoryNotesQuery,
  useMemoryReviewQueueQuery,
} from "@/lib/memory/queries";
import { cn } from "@/lib/ui/cn";

export interface MemoryEntryLinkProps extends Omit<
  React.ComponentProps<typeof Link>,
  "href" | "children"
> {
  projectName: string | null;
  placement: "topbar" | "cockpit" | "menu";
  active?: boolean;
}

export default function MemoryEntryLink({
  projectName,
  placement,
  active = false,
  className,
  ...props
}: MemoryEntryLinkProps) {
  const cockpit = placement === "cockpit";
  const ref = { projectName: cockpit ? projectName : null, sessionName: null };
  const proposed = useMemoryNotesQuery(ref, {
    lifecycle: "proposed",
    includeArchived: false,
  });
  const review = useMemoryReviewQueueQuery(
    ref,
    { promotionCandidates: false, session: null },
    { enabled: cockpit },
  );
  const candidates = useMemoryReviewQueueQuery(
    ref,
    { promotionCandidates: false, projectCandidates: true, session: null },
    { enabled: cockpit && projectName !== null },
  );
  const complete =
    proposed.isSuccess &&
    (!cockpit ||
      (review.isSuccess && (projectName === null || candidates.isSuccess)));
  const count = complete
    ? new Set([
        ...(proposed.data ?? []).map((note) => note.id),
        ...(cockpit
          ? [...(review.data ?? []), ...(candidates.data ?? [])].map(
              (entry) => entry.note.id,
            )
          : []),
      ]).size
    : null;
  const params = new URLSearchParams();
  if (projectName !== null) params.set("project", projectName);
  if (count !== null && count > 0)
    params.set("queue", cockpit ? "attention" : "proposed");
  const label =
    count === null || count === 0
      ? "Memory"
      : cockpit
        ? `Memory · ${count} ${count === 1 ? "note needs" : "notes need"} attention`
        : `Memory · ${count} global ${count === 1 ? "proposal" : "proposals"} awaiting approval`;
  return (
    <Link
      {...props}
      href={`/memory${params.size > 0 ? `?${params}` : ""}`}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      data-active={active}
      className={cn(
        placement === "menu"
          ? "flex items-center gap-sm"
          : "inline-flex min-h-7 items-center gap-sm rounded-sm border border-solid border-border-default bg-bg-surface px-sm font-mono text-[0.7rem] text-text-primary uppercase no-underline hover:bg-bg-raised focus-visible:outline-2 focus-visible:outline-cyan data-[active=true]:border-cyan max-768:min-h-11",
        placement === "topbar" && "max-768:hidden",
        className,
      )}
    >
      Memory{" "}
      {count !== null && count > 0 ? (
        <StatusChip tone="amber">{count}</StatusChip>
      ) : null}
    </Link>
  );
}
