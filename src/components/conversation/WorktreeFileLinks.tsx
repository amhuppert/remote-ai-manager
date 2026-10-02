"use client";

import type { MouseEvent, ReactNode } from "react";
import { ArrowUpRightIcon, DocumentIcon, ImageIcon } from "@/components/icons";
import { WithTooltip } from "@/components/ui/WithTooltip";
import type { WorktreeLinkTarget } from "@/lib/documents/worktree-links";
import { useLinkedFiles, type LinkedFiles } from "./use-linked-files";

/**
 * Message-Markdown renderers for links to scope files. A Markdown link becomes
 * a chip that opens the document viewer; an image link or embed is served from
 * the worktree and previews in a dialog. HTML opens in a new tab. Outside a
 * document scope, where the scope has no Markdown viewer, or for anything
 * else, the caller's ordinary rendering is kept.
 */

type MarkdownTarget = Extract<WorktreeLinkTarget, { kind: "markdown" }>;
type ImageTarget = Extract<WorktreeLinkTarget, { kind: "image" }>;

const FILE_CHIP_CLASSES =
  "inline-flex max-w-full cursor-pointer items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised px-sm py-2xs align-[-0.2em] font-mono text-[0.72rem] leading-[1.45] text-text-primary transition-colors duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-elevated focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

function MarkdownFileChip({
  target,
  onOpen,
  children,
}: {
  target: MarkdownTarget;
  onOpen: NonNullable<LinkedFiles["openMarkdown"]>;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <WithTooltip label={target.docPath}>
      <button
        type="button"
        onClick={(event) =>
          onOpen(
            { docPath: target.docPath, title: target.fileName },
            event.currentTarget,
          )
        }
        className={FILE_CHIP_CLASSES}
      >
        <DocumentIcon size={13} className="shrink-0 text-cyan" />
        <span className="min-w-0 truncate">{children}</span>
        {target.location === "external" ? (
          <span className="shrink-0 text-[0.66rem] text-amber">external</span>
        ) : null}
      </button>
    </WithTooltip>
  );
}

/**
 * A link to the served image. A plain click previews it in place; modifier
 * clicks keep the browser's open-in-new-tab behaviour.
 */
function ImagePreviewLink({
  files,
  target,
  alt,
  label,
  className,
  children,
}: {
  files: LinkedFiles;
  target: ImageTarget;
  alt: string;
  label?: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    files.openImage(
      { imagePath: target.imagePath, fileName: target.fileName, alt },
      event.currentTarget,
    );
  };
  return (
    <a
      href={files.imageUrl(target.imagePath)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      onClick={handleClick}
      className={className}
    >
      {children}
    </a>
  );
}

export function WorktreeFileLink({
  href,
  linkClassName,
  fallback,
  children,
}: {
  href: string | undefined;
  linkClassName: string;
  fallback: React.JSX.Element;
  children: ReactNode;
}): React.JSX.Element {
  const files = useLinkedFiles();
  const target = files?.resolve(href) ?? null;
  if (!files || !target) return fallback;

  if (target.kind === "markdown") {
    if (!files.openMarkdown) return fallback;
    return (
      <MarkdownFileChip target={target} onOpen={files.openMarkdown}>
        {children}
      </MarkdownFileChip>
    );
  }
  if (target.kind === "html") {
    return (
      <WithTooltip label={`${target.htmlPath} · Open in a new tab`}>
        <a
          href={files.htmlUrl(target.htmlPath)}
          target="_blank"
          rel="noopener noreferrer"
          className={FILE_CHIP_CLASSES}
        >
          <DocumentIcon size={13} className="shrink-0 text-cyan" />
          <span className="min-w-0 truncate">{children}</span>
          <span className="shrink-0 text-text-secondary" aria-hidden="true">
            HTML
          </span>
          <ArrowUpRightIcon
            size={13}
            className="shrink-0 text-text-secondary"
          />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </WithTooltip>
    );
  }
  return (
    <ImagePreviewLink
      files={files}
      target={target}
      alt={target.fileName}
      className={linkClassName}
    >
      <ImageIcon
        size={14}
        className="mr-2xs inline-block shrink-0 align-[-0.15em]"
      />
      {children}
    </ImagePreviewLink>
  );
}

export function WorktreeImage({
  src,
  alt,
  imageClassName,
  fallback,
}: {
  src: unknown;
  alt: string;
  imageClassName: string;
  fallback: React.JSX.Element;
}): React.JSX.Element {
  const files = useLinkedFiles();
  const target = files && typeof src === "string" ? files.resolve(src) : null;
  if (!files || target?.kind !== "image") return fallback;

  return (
    <ImagePreviewLink
      files={files}
      target={target}
      alt={alt}
      label={alt === "" ? `Preview ${target.fileName}` : undefined}
      className="inline-block max-w-full cursor-zoom-in rounded-md focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- worktree files have no known dimensions */}
      <img
        src={files.imageUrl(target.imagePath)}
        alt={alt}
        loading="lazy"
        className={imageClassName}
      />
    </ImagePreviewLink>
  );
}
