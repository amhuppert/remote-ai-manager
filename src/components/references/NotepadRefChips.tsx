"use client";

import type { ComponentType, MouseEvent } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  useNotepadSummaryQuery,
  type NotepadSummaryResolution,
} from "@/lib/notepads/queries";
import type { NotepadRefAttrs } from "@/lib/notepads/schemas";

export interface NotepadRefChipDeps {
  useNotepadSummary(notepadId: string): {
    data: NotepadSummaryResolution | undefined;
    isLoading: boolean;
    isError: boolean;
  };
}

interface ResolvedLabel {
  name: string;
  missing: boolean;
}

export interface NotepadRefEditorChipBodyProps {
  notepadId: string;
  /** The name captured when the reference was inserted. */
  name: string;
  selected: boolean;
  onRemove(): void;
}

export function createNotepadRefChips(deps: NotepadRefChipDeps): {
  NotepadRefTranscriptChip: ComponentType<{ attrs: NotepadRefAttrs }>;
  NotepadRefEditorChipBody: ComponentType<NotepadRefEditorChipBodyProps>;
  NotepadRefEditorChip: ComponentType<ReactNodeViewProps<HTMLElement>>;
} {
  /**
   * Resolve the display name from the immutable id, so a rename is reflected
   * without touching the captured reference. While the lookup is in flight — or
   * if it fails for a reason other than deletion — the captured name stands in,
   * which keeps the chip stable rather than flashing a placeholder.
   */
  function useResolvedLabel(
    notepadId: string,
    capturedName: string,
  ): ResolvedLabel {
    const query = deps.useNotepadSummary(notepadId);
    if (query.data?.state === "missing") {
      return { name: capturedName, missing: true };
    }
    return {
      name:
        query.data?.state === "found" ? query.data.summary.name : capturedName,
      missing: false,
    };
  }

  function NotepadRefTranscriptChip({
    attrs,
  }: {
    attrs: NotepadRefAttrs;
  }): React.JSX.Element {
    const label = useResolvedLabel(attrs["notepad-id"], attrs.name);
    return <NotepadChipBody label={label} />;
  }

  function NotepadRefEditorChipBody({
    notepadId,
    name,
    selected,
    onRemove,
  }: NotepadRefEditorChipBodyProps): React.JSX.Element {
    const label = useResolvedLabel(notepadId, name);
    const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove();
    };
    return (
      <span
        className="inline-flex items-center gap-[2px] rounded-md data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)]"
        data-selected={selected ? "true" : "false"}
      >
        <NotepadChipBody label={label} />
        <button
          type="button"
          className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
          onClick={handleRemove}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={`Remove notepad reference ${label.name}`}
        >
          &times;
        </button>
      </span>
    );
  }

  function NotepadRefEditorChip(
    props: ReactNodeViewProps<HTMLElement>,
  ): React.JSX.Element {
    const { node, selected, deleteNode } = props;
    return (
      <NodeViewWrapper as="span" contentEditable={false}>
        <NotepadRefEditorChipBody
          notepadId={stringAttr(node.attrs["notepadId"])}
          name={stringAttr(node.attrs["name"])}
          selected={selected}
          onRemove={deleteNode}
        />
      </NodeViewWrapper>
    );
  }

  return {
    NotepadRefTranscriptChip,
    NotepadRefEditorChipBody,
    NotepadRefEditorChip,
  };
}

/**
 * The pill both chips render. Kind identity rides the blue glyph, so a resolved
 * chip stays neutral-toned; a reference whose notepad has been deleted goes red
 * and says so, rather than silently showing a name that no longer resolves.
 */
function NotepadChipBody({
  label,
}: {
  label: ResolvedLabel;
}): React.JSX.Element {
  return (
    <StatusChip
      tone={label.missing ? "red" : "neutral"}
      icon={<NotepadGlyph missing={label.missing} />}
      aria-label={
        label.missing
          ? `Notepad ${label.name} is missing`
          : `Notepad ${label.name}`
      }
      title={
        label.missing
          ? `${label.name} — this notepad no longer exists`
          : label.name
      }
      data-testid="notepad-ref-chip"
      {...(label.missing ? { "data-notepad-missing": "true" } : {})}
      layoutClassName="max-w-[240px]"
    >
      <span className="truncate">{label.name}</span>
      {label.missing ? <span>· missing</span> : null}
    </StatusChip>
  );
}

function stringAttr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function NotepadGlyph({ missing }: { missing: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      aria-hidden="true"
      className={
        missing
          ? "h-[11px] w-[11px] shrink-0"
          : "h-[11px] w-[11px] shrink-0 text-blue"
      }
    >
      <path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z" />
      <path d="M9.5 2v3.5H13M5.5 8.5h5M5.5 11h3.5" />
    </svg>
  );
}

const productionChips = createNotepadRefChips({
  useNotepadSummary: useNotepadSummaryQuery,
});

export const NotepadRefTranscriptChip =
  productionChips.NotepadRefTranscriptChip;
export const NotepadRefEditorChip = productionChips.NotepadRefEditorChip;
