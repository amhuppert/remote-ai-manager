"use client";

import { useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { getReferenceByXmlTag } from "@/lib/prompt-editor/reference-registry";
import { cn } from "@/lib/ui/cn";
import { createMarkdownComponents, stringProperty } from "./MarkdownRenderer";
import {
  NOTEPAD_IMAGE_ID_PROPERTY,
  NOTEPAD_REF_ATTRS_PROPERTY,
  NOTEPAD_REF_TAG_PROPERTY,
  remarkNotepadContent,
} from "./notepad-markdown-transforms";

export interface NotepadMarkdownRendererProps {
  notepadId: string;
  /** Canonical notepad text: Markdown with reference XML and image tokens. */
  content: string;
}

function NotepadPreviewRefChip({
  refTag,
  attrsJson,
}: {
  refTag: string;
  attrsJson: string;
}): React.JSX.Element | null {
  const entry = getReferenceByXmlTag(refTag);
  const attrs = useMemo(() => parseAttrsJson(attrsJson), [attrsJson]);
  if (!entry || attrs === null) return null;
  const TranscriptChip = entry.TranscriptChip;
  return (
    <span data-testid="notepad-preview-chip" data-ref-kind={refTag}>
      <TranscriptChip attrs={attrs} />
    </span>
  );
}

function parseAttrsJson(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Design 03 "degraded, never broken": an image whose data is gone keeps its
 * slot as a labelled placeholder instead of a broken-image glyph. Span-based
 * because the element sits in phrasing position inside a paragraph.
 */
function NotepadPreviewImage({
  src,
  alt,
  imageId,
}: {
  src: string;
  alt: string;
  imageId: string;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        data-testid="notepad-image-placeholder"
        data-notepad-image-id={imageId}
        className="my-sm flex flex-col items-center gap-xs rounded-md border border-dashed border-border-default bg-bg-base px-md py-lg text-text-tertiary"
      >
        <MissingImageGlyph />
        <span className="text-[0.68rem]">image unavailable</span>
      </span>
    );
  }
  return (
    // Notepad image sources do not provide the dimensions required by next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      data-testid="notepad-preview-image"
      data-notepad-image-id={imageId}
      className="h-auto max-w-full rounded-md"
      onError={() => setFailed(true)}
    />
  );
}

function MissingImageGlyph(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 17l5-5 4 4 3-3 6 6" />
    </svg>
  );
}

const BASE_COMPONENTS = createMarkdownComponents("document");

/**
 * The base map plus the two element kinds only the notepad transform emits.
 * Ordinary markdown never yields `span` elements (raw HTML is not parsed), so
 * the span override only ever sees chip elements — the plain-span branch is a
 * guard, not a rendering path.
 */
const NOTEPAD_COMPONENTS: Components = {
  ...BASE_COMPONENTS,
  span({ node, className, children, ...props }) {
    const refTag = stringProperty(node?.properties[NOTEPAD_REF_TAG_PROPERTY]);
    if (refTag === undefined) {
      return (
        <span {...props} className={className}>
          {children}
        </span>
      );
    }
    return (
      <NotepadPreviewRefChip
        refTag={refTag}
        attrsJson={
          stringProperty(node?.properties[NOTEPAD_REF_ATTRS_PROPERTY]) ?? ""
        }
      />
    );
  },
  img({ node, className, alt, ...props }) {
    const imageId = stringProperty(node?.properties[NOTEPAD_IMAGE_ID_PROPERTY]);
    if (imageId === undefined) {
      return (
        // Markdown image sources do not provide the dimensions required by next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...props}
          alt={alt ?? ""}
          loading="lazy"
          className={cn("h-auto max-w-full rounded-md", className)}
        />
      );
    }
    return (
      <NotepadPreviewImage
        src={stringProperty(node?.properties["src"]) ?? ""}
        alt={alt ?? ""}
        imageId={imageId}
      />
    );
  },
};

function NotepadMarkdownRenderer({
  notepadId,
  content,
}: NotepadMarkdownRendererProps): React.JSX.Element {
  // remark-breaks mirrors the canonical renderer: single-newline content keeps
  // rendering as visible line breaks without a pre-wrap root.
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, remarkBreaks, [remarkNotepadContent, { notepadId }]],
    [notepadId],
  );

  return (
    <div
      data-notepad-markdown
      className="max-w-full min-w-0 font-body text-[0.95rem] leading-[1.75] [overflow-wrap:anywhere] break-words text-text-primary selection:bg-cyan-glow-strong"
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={NOTEPAD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default NotepadMarkdownRenderer;
