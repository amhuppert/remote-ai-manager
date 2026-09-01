/**
 * The clip fragment: the one mapping contract every capture surface writes
 * through (D20). Server-safe by construction — no React, no Tiptap — because
 * the same builder is reached from client capture surfaces and from tests that
 * run this alongside the injection pass (see the note atop `injection.ts`).
 */

/**
 * Where a clip came from, rendered onto the fragment's attribution line. Hosts
 * with a registry reference kind carry its XML; the document viewer has none,
 * so it carries a repo-relative path — still retrievable, agents read files.
 */
export type ClipProvenance =
  | { kind: "ref"; xml: string }
  | { kind: "path"; path: string };

export interface ClipFragmentInput {
  /** The clipped text exactly as the user selected it. */
  text: string;
  /** The selection lies within code, so it is fenced rather than quoted. */
  isCode: boolean;
  provenance: ClipProvenance;
}

/** The em dash opening every attribution line, whatever the provenance kind. */
const ATTRIBUTION_PREFIX = "— ";

/**
 * A clip's canonical text: the quoted or fenced selection, then the attribution
 * line (D20). The fragment carries no leading or trailing separator — the blank
 * line that divides it from existing content is applied exactly once by the
 * append composition rule the notepads repo owns, so both landing paths (HTTP
 * append and the open editor) compose byte-identical content.
 */
export function buildClipFragment(input: ClipFragmentInput): string {
  const quoted = input.isCode ? fenceCode(input.text) : blockquote(input.text);
  return `${quoted}\n${ATTRIBUTION_PREFIX}${renderProvenance(input.provenance)}`;
}

/**
 * Every line carries the marker so a blank line inside the selection continues
 * the quote instead of ending it. Blank lines take the bare marker: a trailing
 * space is invisible in the editor and the first thing a formatter strips.
 */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/** The triple-backtick fence the notepad dialect emits and recognizes. */
const MIN_FENCE_BACKTICKS = 3;

/**
 * A fence long enough that nothing inside the selection can close it: code is
 * clipped verbatim, and clipped code routinely carries its own fence (a
 * markdown answer, a doc excerpt). CommonMark closes on the first line of at
 * least as many backticks, so a fixed ``` would spill the rest of the selection
 * — and the attribution line behind it — outside the block.
 */
function fenceCode(text: string): string {
  const fence = "`".repeat(fenceLength(text));
  return `${fence}\n${text}\n${fence}`;
}

function fenceLength(text: string): number {
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  return Math.max(MIN_FENCE_BACKTICKS, ...runs.map((run) => run + 1));
}

function renderProvenance(provenance: ClipProvenance): string {
  return provenance.kind === "ref" ? provenance.xml : provenance.path;
}
