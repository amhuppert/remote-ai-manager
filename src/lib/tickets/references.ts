import { escapeXmlAttr } from "@/lib/shared/xml";
import { quoteAgentCommandArgument } from "./command-arguments";

/**
 * Everything needed to render a `<ticket-ref ... />` tag. Built by the
 * copy-reference control and by the prompt-editor serializer when it
 * encounters a ticket mention chip.
 */
export interface TicketRefInput {
  projectName: string;
  ticketNumber: number;
  title: string;
}

/** Human-facing ticket identity, e.g. `command-center#12`. */
export function formatTicketIdentifier(
  projectName: string,
  ticketNumber: number,
): string {
  return `${projectName}#${ticketNumber}`;
}

/**
 * The globally-valid read command embedded in every ticket ref — cctl
 * resolves the owning project from the identifier, so the command works from
 * any conversation in any project.
 */
export function buildTicketReadCommand(identifier: string): string {
  return `cctl ticket get ${quoteAgentCommandArgument(identifier)}`;
}

/**
 * Inverse of `formatTicketIdentifier`. Splits on the LAST `#` so project
 * names containing `#` survive; returns null unless the tail is a positive
 * integer.
 */
export function parseTicketIdentifier(
  identifier: string,
): { projectName: string; ticketNumber: number } | null {
  const hash = identifier.lastIndexOf("#");
  if (hash <= 0) return null;
  const projectName = identifier.slice(0, hash);
  const tail = identifier.slice(hash + 1);
  if (!/^[0-9]+$/.test(tail)) return null;
  const ticketNumber = Number(tail);
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber <= 0) return null;
  return { projectName, ticketNumber };
}

/**
 * Render the canonical self-closing `<ticket-ref ... />` XML tag in canonical
 * attribute order. The ref carries display identity plus the embedded read
 * command an agent can run verbatim — never project paths, snapshot keys, or
 * attachment content.
 */
export function buildTicketRefXml(input: TicketRefInput): string {
  const identifier = formatTicketIdentifier(
    input.projectName,
    input.ticketNumber,
  );
  const attrs: Array<[string, string]> = [
    ["project-name", input.projectName],
    ["ticket-number", String(input.ticketNumber)],
    ["identifier", identifier],
    ["title", input.title],
    ["read-command", buildTicketReadCommand(identifier)],
  ];
  const rendered = attrs
    .map(([name, value]) => `${name}="${escapeXmlAttr(value)}"`)
    .join(" ");
  return `<ticket-ref ${rendered} />`;
}
