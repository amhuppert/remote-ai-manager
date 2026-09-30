"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type {
  SlashCommandKind,
  SlashCommandMarkerAttrs,
  SlashCommandTriggerChar,
} from "@/lib/prompt-editor";
import { CloseIcon } from "@/components/icons";
import { WithTooltip } from "@/components/ui/WithTooltip";

function coerceAttrs(value: unknown): SlashCommandMarkerAttrs {
  if (typeof value !== "object" || value === null) {
    return {
      name: "",
      trigger: "/",
      kind: "command",
      source: "",
      description: null,
      argumentHint: null,
    };
  }
  const v = value as Record<string, unknown>;
  const trigger: SlashCommandTriggerChar = v["trigger"] === "$" ? "$" : "/";
  const kind: SlashCommandKind = v["kind"] === "skill" ? "skill" : "command";
  return {
    name: typeof v["name"] === "string" ? v["name"] : "",
    trigger,
    kind,
    source: typeof v["source"] === "string" ? v["source"] : "",
    description: typeof v["description"] === "string" ? v["description"] : null,
    argumentHint:
      typeof v["argumentHint"] === "string" ? v["argumentHint"] : null,
  };
}

export default function SlashCommandChip(
  props: ReactNodeViewProps<HTMLElement>,
): React.JSX.Element {
  const { node, selected, deleteNode, editor } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
    editor.commands.focus();
  };

  const displayName = attrs.name.startsWith(attrs.trigger)
    ? attrs.name.slice(1)
    : attrs.name;
  const shortName =
    attrs.kind === "skill" &&
    attrs.source &&
    displayName.startsWith(`${attrs.source}:`)
      ? displayName.slice(attrs.source.length + 1)
      : displayName;
  const label = `${attrs.kind === "skill" ? "Skill" : "Command"} ${displayName}`;

  return (
    <NodeViewWrapper
      as="span"
      className="group inline-flex max-w-[min(100%,28rem)] items-center rounded-md border border-border-default bg-bg-raised align-middle font-mono text-[0.75rem] leading-none shadow-[inset_2px_0_0_var(--color-cyan)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-border-strong hover:bg-bg-elevated data-[kind=skill]:shadow-[inset_2px_0_0_var(--color-border-strong)] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)]"
      data-selected={selected ? "true" : "false"}
      data-kind={attrs.kind}
      data-trigger={attrs.trigger}
      contentEditable={false}
    >
      <WithTooltip
        label={
          <span className="flex flex-col gap-xs break-words">
            <span className="text-[0.7rem] font-semibold tracking-[0.08em] text-cyan">
              {attrs.kind === "skill" ? "SKILL" : "COMMAND"}
            </span>
            <span className="font-semibold text-text-primary">{shortName}</span>
            {attrs.description ? <span>{attrs.description}</span> : null}
            {attrs.kind === "skill" ? (
              <span className="break-all text-text-tertiary">{attrs.name}</span>
            ) : attrs.source ? (
              <span className="text-text-tertiary">Source: {attrs.source}</span>
            ) : null}
          </span>
        }
        side="top"
      >
        <span
          className="flex min-h-8 min-w-0 items-center gap-xs rounded-sm py-xs pr-2xs pl-sm outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
          tabIndex={0}
          aria-label={label}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-cyan-glow font-semibold text-cyan">
            {attrs.trigger}
          </span>
          <span className="min-w-0 truncate font-medium text-text-primary">
            {shortName}
          </span>
          {attrs.source && attrs.kind !== "skill" ? (
            <span className="max-w-[9rem] shrink truncate text-[0.7rem] text-text-tertiary max-768:hidden">
              {attrs.source}
            </span>
          ) : null}
        </span>
      </WithTooltip>
      <WithTooltip label={`Remove ${attrs.kind}`} side="top">
        <button
          type="button"
          className="mr-2xs flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary outline-none transition-colors duration-150 hover:bg-red-glow hover:text-red-text focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:mr-0 max-768:h-[44px] max-768:w-[44px]"
          onClick={handleRemove}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={`Remove ${attrs.name}`}
        >
          <CloseIcon size={14} />
        </button>
      </WithTooltip>
    </NodeViewWrapper>
  );
}
