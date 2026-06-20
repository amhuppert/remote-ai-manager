"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import type { MouseEvent } from "react";
import type {
  SlashCommandKind,
  SlashCommandMarkerAttrs,
  SlashCommandTriggerChar,
} from "@/lib/prompt-editor";

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
  const { node, selected, deleteNode } = props;
  const attrs = coerceAttrs(node.attrs);

  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  };

  const displayName = attrs.name.startsWith(attrs.trigger)
    ? attrs.name.slice(1)
    : attrs.name;

  return (
    <NodeViewWrapper
      as="span"
      className="group inline-flex items-center gap-xs rounded-md border border-border-default bg-bg-raised py-2xs pr-xs pl-[6px] align-baseline font-mono text-[0.78rem] leading-none transition-[border-color,box-shadow] duration-150 data-[kind=skill]:border-amber-dim data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:pt-xs max-768:pr-[6px] max-768:pb-xs max-768:pl-sm"
      data-selected={selected ? "true" : "false"}
      data-kind={attrs.kind}
      data-trigger={attrs.trigger}
      contentEditable={false}
      title={attrs.description ?? attrs.name}
    >
      <span className="font-semibold text-cyan group-data-[kind=skill]:text-amber">
        {attrs.trigger}
      </span>
      <span className="text-text-primary">{displayName}</span>
      {attrs.source ? (
        <span className="rounded-[3px] bg-bg-surface px-xs py-[1px] text-[0.7rem] text-text-tertiary lowercase">
          {attrs.source}
        </span>
      ) : null}
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove ${attrs.name}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
