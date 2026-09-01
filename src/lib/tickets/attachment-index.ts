import { attachmentGetCommand } from "./attachment-commands";
import type { TicketAttachment, TicketAttachmentKind } from "./schemas";

/**
 * Shared typed attachment-index renderer. Every surface that shows a ticket's
 * attachment index — the live ticket block, the kickoff prompt, CLI text and
 * JSON output, and reference resolution — consumes these entries so index
 * shape and command wording never fork per surface. Pure: consumers own
 * logging (entry count and rendered size, never descriptions or content).
 */

/**
 * Fixed per-entry description budget for bounded mode (characters, including
 * the ellipsis). Bounded mode may shorten descriptions but NEVER omits
 * entries — an attachment-count cap would be a requirements change, not a
 * silent prompt cap.
 */
export const BOUNDED_DESCRIPTION_BUDGET = 120;

export type AttachmentIndexMode = "bounded" | "full";

export interface AttachmentIndexEntry {
  attachmentId: string;
  kind: TicketAttachmentKind;
  /** Single-line description text; shortened to the budget in bounded mode. */
  description: string;
  truncated: boolean;
  /** Exact retrieval command first, then any follow command. */
  commands: string[];
}

export interface BuildAttachmentIndexInput {
  /** Host ticket identifier (`project#number`). */
  identifier: string;
  attachments: TicketAttachment[];
  mode: AttachmentIndexMode;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function boundDescription(
  description: string,
  mode: AttachmentIndexMode,
): { description: string; truncated: boolean } {
  const normalized = singleLine(description);
  if (mode === "full" || normalized.length <= BOUNDED_DESCRIPTION_BUDGET) {
    return { description: normalized, truncated: false };
  }
  return {
    description: `${normalized.slice(0, BOUNDED_DESCRIPTION_BUDGET - 1)}…`,
    truncated: true,
  };
}

function commandsFor(
  identifier: string,
  attachment: TicketAttachment,
): string[] {
  return [attachmentGetCommand(identifier, attachment.id)];
}

export function buildAttachmentIndex(
  input: BuildAttachmentIndexInput,
): AttachmentIndexEntry[] {
  return input.attachments.map((attachment) => {
    const bounded = boundDescription(attachment.description, input.mode);
    return {
      attachmentId: attachment.id,
      kind: attachment.payload.kind,
      description: bounded.description,
      truncated: bounded.truncated,
      commands: commandsFor(input.identifier, attachment),
    };
  });
}

/** One `- <id> <kind> — <description> — <commands>` line per entry. */
export function renderAttachmentIndexLines(
  entries: AttachmentIndexEntry[],
): string[] {
  return entries.map(
    (entry) =>
      `- ${entry.attachmentId} ${entry.kind} — ${entry.description} — ${entry.commands.join("; ")}`,
  );
}
