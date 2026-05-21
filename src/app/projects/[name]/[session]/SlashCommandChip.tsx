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
      className="slash-command-chip"
      data-selected={selected ? "true" : "false"}
      data-kind={attrs.kind}
      data-trigger={attrs.trigger}
      contentEditable={false}
      title={attrs.description ?? attrs.name}
    >
      <span className="slash-command-chip__trigger">{attrs.trigger}</span>
      <span className="slash-command-chip__name">{displayName}</span>
      {attrs.source ? (
        <span className="slash-command-chip__source">{attrs.source}</span>
      ) : null}
      <button
        type="button"
        className="slash-command-chip__remove"
        onClick={handleRemove}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={`Remove ${attrs.name}`}
      >
        &times;
      </button>
    </NodeViewWrapper>
  );
}
