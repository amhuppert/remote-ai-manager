import { escapeXmlAttr } from "@/lib/shared/xml";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";
import type { NotepadScope } from "./schemas";

/**
 * Everything needed to render a `<notepad-ref ... />` tag. Built by the
 * reference picker and by the prompt-editor serializer when it encounters a
 * notepad mention chip.
 */
export interface NotepadRefInput {
  /** The immutable id — the only key a reference ever resolves by. */
  notepadId: string;
  /** Display snapshot; the chip re-resolves it live, so a rename is safe. */
  name: string;
  scope: NotepadScope;
  /** The owning project's display name; null for a global notepad. */
  projectName: string | null;
}

/**
 * The globally-valid read command embedded in every notepad ref. Notepads are
 * addressed by id alone, so the command works from any conversation in any
 * project — and survives a rename, which a name-addressed command would not.
 */
export function buildNotepadReadCommand(notepadId: string): string {
  return `cctl notepad get ${quoteAgentCommandArgument(notepadId)}`;
}

/**
 * Render the canonical self-closing `<notepad-ref ... />` XML tag in canonical
 * attribute order. A global notepad omits `project-name` rather than carrying
 * an empty one. The read command is re-derived from the id, so the emitted XML
 * stays canonical regardless of what was pasted.
 */
export function buildNotepadRefXml(input: NotepadRefInput): string {
  const attrs: Array<[string, string]> = [
    ["notepad-id", input.notepadId],
    ["name", input.name],
    ["scope", input.scope],
    ...(input.scope === "project" && input.projectName
      ? ([["project-name", input.projectName]] as Array<[string, string]>)
      : []),
    ["read-command", buildNotepadReadCommand(input.notepadId)],
  ];
  const rendered = attrs
    .map(([name, value]) => `${name}="${escapeXmlAttr(value)}"`)
    .join(" ");
  return `<notepad-ref ${rendered} />`;
}
