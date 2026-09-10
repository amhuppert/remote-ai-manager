"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { LiveReferenceChip } from "@/components/references/LiveReferenceChip";
import { buildTicketRefXml } from "@/lib/tickets/references";
import type { TicketMentionAttrs } from "@/lib/prompt-editor";

function coerceAttrs(value: unknown): TicketMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return EMPTY_ATTRS;
  }
  const v = value as Record<string, unknown>;
  return {
    projectName: str(v["projectName"]),
    ticketNumber: str(v["ticketNumber"]),
    identifier: str(v["identifier"]),
    title: str(v["title"]),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const EMPTY_ATTRS: TicketMentionAttrs = {
  projectName: "",
  ticketNumber: "0",
  identifier: "",
  title: "",
};

export default function TicketMentionChip({
  node,
  selected,
  deleteNode,
}: ReactNodeViewProps<HTMLElement>): React.JSX.Element {
  const attrs = coerceAttrs(node.attrs);
  return (
    <NodeViewWrapper
      as="span"
      data-ticket-mention-chip=""
      contentEditable={false}
    >
      <LiveReferenceChip
        target={{
          kind: "ticket",
          projectName: attrs.projectName,
          id: attrs.ticketNumber,
        }}
        title={attrs.title}
        identity={attrs.identifier}
        selected={selected}
        onRemove={deleteNode}
        reference={buildTicketRefXml({
          projectName: attrs.projectName,
          ticketNumber: Number(attrs.ticketNumber),
          title: attrs.title,
        })}
      />
    </NodeViewWrapper>
  );
}
