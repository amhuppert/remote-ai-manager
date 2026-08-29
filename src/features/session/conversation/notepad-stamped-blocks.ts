"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

import {
  CC_LINE_ATTR,
  CC_SECTION_ATTR,
  resolveBlockMeta,
  type BlockMeta,
} from "@/components/markdown/markdown-source-map";

/**
 * The block identities the notepad rendering ACTUALLY stamped, read back out of
 * the rendered document and keyed by canonical line.
 *
 * A stored anchor carries the section id its block had when the comment was
 * written, and a section id is derived from the heading above the block — so
 * renaming a heading restamps every block beneath it while leaving their text
 * untouched. The seam locates a block by line AND section, so the stored pair
 * would address a block the rendering no longer has, and a comment on prose
 * nobody edited would paint nowhere. Reading the identity back from the DOM
 * restates it against what the renderer emitted rather than against a second
 * derivation that could disagree with it.
 *
 * Blocks nest (a `ul` and its `li` share an opening line), but nesting cannot
 * cross a heading, so every element stamped with a given line carries the same
 * section — which one wins is immaterial.
 */
export type NotepadStampedBlocks = ReadonlyMap<number, BlockMeta>;

const NO_STAMPED_BLOCKS: NotepadStampedBlocks = new Map();

export function readStampedBlocks(
  container: ParentNode | null,
): NotepadStampedBlocks {
  if (container === null) return NO_STAMPED_BLOCKS;
  const stamped = new Map<number, BlockMeta>();
  for (const element of container.querySelectorAll<HTMLElement>(
    `[${CC_LINE_ATTR}]`,
  )) {
    const meta = resolveBlockMeta(element);
    if (meta !== null) stamped.set(meta.line, meta);
  }
  return stamped;
}

function sameStampedBlocks(
  left: NotepadStampedBlocks,
  right: NotepadStampedBlocks,
): boolean {
  if (left.size !== right.size) return false;
  for (const [line, meta] of left) {
    const other = right.get(line);
    if (
      other === undefined ||
      other.sectionId !== meta.sectionId ||
      other.headingLabel !== meta.headingLabel
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Track the rendered document's stamped block identities. The notepad rendering
 * is deferred and debounced, so the stamps appear some commits after this
 * component first renders; the observer catches that mount the same way the
 * seam's own live resolution does.
 *
 * An unchanged reading returns the previous map so the annotation projection
 * downstream keeps its identity — the seam re-resolves whenever its sources
 * change, and a fresh map on every unrelated DOM mutation would spin that.
 *
 * Its emptiness is also the panel's answer to "has the document rendered yet",
 * which is why it is read rather than inferred from an annotation resolving: a
 * notepad with one comment that resolves nowhere would otherwise look
 * indistinguishable from a document that has not mounted, and the comment would
 * be neither painted nor badged stale.
 */
export function useNotepadStampedBlocks(
  contentRef: RefObject<HTMLElement | null>,
  content: string,
): NotepadStampedBlocks {
  const [stamped, setStamped] =
    useState<NotepadStampedBlocks>(NO_STAMPED_BLOCKS);

  useLayoutEffect(() => {
    const read = (): void => {
      setStamped((current) => {
        const next = readStampedBlocks(contentRef.current);
        return sameStampedBlocks(current, next) ? current : next;
      });
    };
    read();

    const contentEl = contentRef.current;
    if (contentEl === null) return;
    const observer = new MutationObserver(read);
    observer.observe(contentEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [CC_LINE_ATTR, CC_SECTION_ATTR],
    });
    return () => observer.disconnect();
  }, [content, contentRef]);

  return stamped;
}
