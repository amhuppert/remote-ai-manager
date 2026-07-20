"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import type { TicketRefInput } from "@/lib/tickets/references";

import { copyTicketReference } from "./copy-ticket-reference";

export type CopyTicketReferenceButtonProps = TicketRefInput & {
  layoutClassName?: string;
};

/**
 * Copies the canonical `<ticket-ref ... />` XML tag for a ticket to the
 * clipboard — a reference any agent can resolve via the embedded globally
 * valid read command, and which the prompt editor swaps for a mention chip
 * on paste.
 */
export default function CopyTicketReferenceButton({
  projectName,
  ticketNumber,
  title,
  layoutClassName,
}: CopyTicketReferenceButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const didCopy = await copyTicketReference(
      { projectName, number: ticketNumber, title },
      { announceSuccess: false },
    );
    if (!didCopy) return;

    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [projectName, ticketNumber, title]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void handleCopy()}
      title="Copy ticket reference"
      aria-label="Copy ticket reference"
      layoutClassName={layoutClassName}
    >
      {copied ? "Copied ✓" : "Copy reference"}
    </Button>
  );
}
