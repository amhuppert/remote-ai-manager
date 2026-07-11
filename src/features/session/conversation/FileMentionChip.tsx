"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { FileMentionAttrs } from "@/lib/prompt-editor";
import { isMarkdownPath, normalizeMarkdownLocator } from "@/lib/documents/path";
import { useOpenDocument } from "@/stores/session-detail.store";
import { useDocumentScope } from "@/components/conversation/document-scope";

function coerceAttrs(value: unknown): FileMentionAttrs {
  if (typeof value !== "object" || value === null) {
    return { path: "", basename: "", ext: "" };
  }
  const v = value as Record<string, unknown>;
  return {
    path: typeof v["path"] === "string" ? v["path"] : "",
    basename: typeof v["basename"] === "string" ? v["basename"] : "",
    ext: typeof v["ext"] === "string" ? v["ext"] : "",
  };
}

export default function FileMentionChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  return (
    <NodeViewWrapper
      as="span"
      className={FILE_MENTION_WRAPPER_CLASS}
      data-selected={selected ? "true" : "false"}
      data-ext={attrs.ext}
      contentEditable={false}
      title={attrs.path}
    >
      <FileMentionChipBody attrs={attrs} onRemove={() => deleteNode()} />
    </NodeViewWrapper>
  );
}

export const FILE_MENTION_WRAPPER_CLASS =
  "inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[44px] max-768:py-[4px] max-768:pr-[4px] max-768:pl-[8px]";

export function FileMentionChipBody({
  attrs,
  onRemove,
}: {
  attrs: FileMentionAttrs;
  onRemove(): void;
}): React.JSX.Element {
  const scope = useDocumentScope();
  const openDocument = useOpenDocument();
  const displayName = attrs.basename.length > 0 ? attrs.basename : attrs.path;
  const canOpen = scope !== null && isMarkdownPath(attrs.path);

  const label = (
    <>
      <span className="font-semibold text-cyan">@</span>
      <span className="text-text-primary">{displayName}</span>
      {attrs.ext ? (
        <span className="rounded-[3px] bg-bg-surface px-[4px] py-[1px] text-[0.7rem] text-text-tertiary lowercase">
          {attrs.ext}
        </span>
      ) : null}
    </>
  );

  const open = (): void => {
    if (!scope) return;
    const normalized = normalizeMarkdownLocator(attrs.path, scope.worktreePath);
    if (!normalized.ok) return;
    openDocument({
      projectName: scope.projectName,
      sessionName: scope.sessionName,
      docPath: normalized.docPath,
      title: displayName,
    });
  };

  return (
    <>
      {canOpen ? (
        <button
          type="button"
          aria-label={`Open @${attrs.path} in Markdown viewer`}
          onClick={open}
          onMouseDown={(event) => event.preventDefault()}
          className="font-inherit inline-flex cursor-pointer items-center gap-xs rounded-sm border-0 bg-transparent p-0 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
        >
          {label}
        </button>
      ) : (
        <span className="inline-flex items-center gap-xs">{label}</span>
      )}
      <button
        type="button"
        className="flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-text-tertiary hover:bg-red-glow hover:text-red-text focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:h-[44px] max-768:w-[44px]"
        onClick={onRemove}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={`Remove @${attrs.path}`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          className="size-[14px]"
        >
          <path
            d="m6 6 12 12M18 6 6 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        </svg>
      </button>
    </>
  );
}
