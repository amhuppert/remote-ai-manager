/**
 * Server-side full-content injection for notepad references in outgoing prompt
 * text (D5). Runs at the one seam where agent-facing text already diverges from
 * the durable transcript, so the transcript keeps the un-expanded reference and
 * the chip still renders in history.
 */

// `ref-tags`, not `ref-parser`: this module is reached from API routes, and the
// registry `ref-parser` imports pulls React chips and Tiptap nodes into their
// server module graph, which fails page-data collection at build time.
import { findRefTags } from "@/lib/conversations/ref-tags";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";
import type { NotepadService } from "./service";
import type { NotepadWriteMode } from "./schemas";

/**
 * The reference registry's tag for the notepad kind. Restated here because the
 * injection pass addresses one tag directly rather than enumerating the
 * registry; `injection.test.ts` pins it against the registry entry.
 */
export const NOTEPAD_REF_XML_TAG = "notepad-ref";

/** The immutable id is the only key a reference ever resolves by (R4). */
export const NOTEPAD_REF_ID_ATTR = "notepad-id";

/** The verbatim command an agent runs to retrieve a notepad by id. */
export function buildNotepadReadCommand(notepadId: string): string {
  return `cctl notepad get ${quoteAgentCommandArgument(notepadId)}`;
}

/** The fields injection delivers — a narrow read, not the whole entity. */
export interface NotepadInjectionSource {
  id: string;
  name: string;
  revision: number;
  writeMode: NotepadWriteMode;
  /** Canonical Markdown text with inline reference XML and image tokens. */
  content: string;
}

/**
 * Injection's read seam. Backed by the NotepadService in production so the
 * service stays the single owner of notepad reads; a dangling reference
 * resolves to null rather than throwing.
 */
export interface NotepadInjectionReader {
  readForInjection(notepadId: string): Promise<NotepadInjectionSource | null>;
}

/**
 * Injection's production reader. `not_found` is the one refusal injection can
 * render (a dangling reference); any other refusal is a real fault and is
 * raised so the delivery seam logs it rather than reporting the notepad gone.
 */
export function createNotepadInjectionReader(
  service: NotepadService,
): NotepadInjectionReader {
  return {
    async readForInjection(notepadId) {
      const result = await service.get(notepadId);
      if (result.ok) {
        const { id, name, revision, writeMode, content } = result.value;
        return { id, name, revision, writeMode, content };
      }
      if (result.error.code === "not_found") return null;
      throw new Error(
        `Notepad ${notepadId} could not be read for injection: ${result.error.message}`,
      );
    },
  };
}

/** Header values are one line each, so a multi-line name cannot break the block. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderNotepadBlock(notepad: NotepadInjectionSource): string {
  return [
    "<notepad>",
    `id: ${notepad.id}`,
    `name: ${singleLine(notepad.name)}`,
    `revision: ${notepad.revision}`,
    `write-mode: ${notepad.writeMode}`,
    `read: ${buildNotepadReadCommand(notepad.id)}`,
    "---",
    notepad.content,
    "</notepad>",
  ].join("\n");
}

/**
 * A dangling reference is reported rather than dropped: the agent learns the
 * notepad is gone instead of silently receiving a prompt with a hole in it.
 */
function renderMissingNotepadBlock(notepadId: string): string {
  return [
    "<notepad>",
    `id: ${notepadId}`,
    "status: not found — the notepad was deleted, or the reference is stale.",
    "</notepad>",
  ].join("\n");
}

/**
 * The outcome of one expansion pass: the agent-facing text, plus the notepads
 * whose content it actually carried. `delivered` is what makes a notepad
 * tracked for the conversation (R21) — it names the exact revisions the agent
 * was shown, which a re-read at recording time could no longer prove.
 */
export interface NotepadExpansionResult {
  text: string;
  /** Resolved notepads in first-reference order; a dangling ref is absent. */
  delivered: readonly NotepadInjectionSource[];
}

/**
 * Replace every notepad reference in `text` with the notepad's full canonical
 * content. Single-pass by construction: only the original text is scanned and
 * injected output is never re-scanned, so nested notepad references arrive as
 * references (agents retrieve them through the read command the XML names) and
 * reference cycles cannot recurse.
 *
 * The tokenizer skips fenced code blocks, so a reference shown as an example
 * stays literal.
 */
export async function expandNotepadRefsForAgent(
  text: string,
  reader: NotepadInjectionReader,
): Promise<NotepadExpansionResult> {
  const refs = findRefTags(text, NOTEPAD_REF_XML_TAG);
  if (refs.length === 0) return { text, delivered: [] };

  // One read per distinct id: repeating a reference delivers the same revision
  // twice rather than racing two reads against a concurrent write.
  const resolved = new Map<string, NotepadInjectionSource | null>();
  for (const ref of refs) {
    const notepadId = ref.attrs[NOTEPAD_REF_ID_ATTR];
    if (notepadId === undefined || resolved.has(notepadId)) continue;
    resolved.set(notepadId, await reader.readForInjection(notepadId));
  }

  const out: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    const notepadId = ref.attrs[NOTEPAD_REF_ID_ATTR];
    // A tag with no id resolves to nothing; leave it embedded in the text.
    if (notepadId === undefined) continue;
    const notepad = resolved.get(notepadId) ?? null;
    out.push(text.slice(cursor, ref.start));
    out.push(
      notepad === null
        ? renderMissingNotepadBlock(notepadId)
        : renderNotepadBlock(notepad),
    );
    cursor = ref.end;
  }
  out.push(text.slice(cursor));
  return {
    text: out.join(""),
    // Insertion-ordered, so the report follows first-reference order and a
    // repeated reference is named once — the same one-read-per-id rule above.
    delivered: [...resolved.values()].filter(
      (notepad): notepad is NotepadInjectionSource => notepad !== null,
    ),
  };
}
