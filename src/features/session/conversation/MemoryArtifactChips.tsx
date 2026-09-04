"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { StatusChip } from "@/components/ui/StatusChip";
import { renderMemoryArtifactHandle } from "@/lib/memory/artifact-handles";
import type { MemoryArtifactRef, MemoryLink } from "@/lib/memory/schemas";
import { specReferenceQueries } from "@/lib/specs/reference-queries";
import { ticketQueries } from "@/lib/tickets/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";

export interface MemoryArtifactChipsProps {
  projectName: string;
  links: readonly MemoryLink[];
}

/**
 * The artifacts a note is linked to, each rendered as its canonical handle —
 * the same string `cctl memory` prints and accepts back, so a chip and a
 * command name the same thing.
 *
 * A link stores the artifact's IMMUTABLE id, while the pages that show tickets
 * and specs are addressed by project-scoped number and slug. The two project
 * listings the app already caches supply that mapping; a link whose target has
 * no page addressable from the ref alone (a workflow execution, a lane's
 * execution context) stays an informative chip rather than a dead link.
 */
export default function MemoryArtifactChips({
  projectName,
  links,
}: MemoryArtifactChipsProps): React.JSX.Element | null {
  const wantsTickets = links.some((link) => link.artifact.kind === "ticket");
  const wantsSpecs = links.some((link) => link.artifact.kind === "spec");

  const tickets = useQuery({
    ...ticketQueries.list({ projectName }),
    enabled: wantsTickets,
  });
  const specs = useQuery({
    ...specReferenceQueries.inventory(projectName),
    enabled: wantsSpecs,
  });

  if (links.length === 0) return null;

  const hrefOf = (artifact: MemoryArtifactRef): string | null => {
    switch (artifact.kind) {
      case "ticket": {
        const ticket = tickets.data?.find(
          (candidate) => candidate.id === artifact.ticketId,
        );
        return ticket === undefined
          ? null
          : ticketDetailHref(projectName, ticket.number);
      }
      case "spec": {
        const spec = specs.data?.specs.find(
          (candidate) => candidate.spec.id === artifact.specId,
        );
        return spec === undefined
          ? null
          : `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(spec.spec.slug)}`;
      }
      case "session":
        return `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(artifact.sessionName)}`;
      case "workflow_execution":
      case "workflow_context":
        return null;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-[4px] border-0 border-t border-solid border-border-subtle px-[12px] py-[8px]">
      <span className="font-mono text-[0.68rem] tracking-[0.05em] text-text-tertiary uppercase">
        Links
      </span>
      {links.map((link) => {
        const label = `${link.kind}: ${renderMemoryArtifactHandle(link.artifact)}`;
        const href = hrefOf(link.artifact);
        return href === null ? (
          <StatusChip key={link.id} tone="cyan" wrap>
            {label}
          </StatusChip>
        ) : (
          <Link
            key={link.id}
            href={href}
            aria-label={`Open ${renderMemoryArtifactHandle(link.artifact)}`}
            className="no-underline"
          >
            <StatusChip tone="cyan" wrap>
              {label}
            </StatusChip>
          </Link>
        );
      })}
    </div>
  );
}
