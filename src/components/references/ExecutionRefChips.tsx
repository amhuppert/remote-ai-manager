"use client";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import {
  buildExecutionRefXml,
  executionRefAttrsSchema,
  type ExecutionRefAttrs,
} from "@/lib/workflow-graph/references";
import { LiveReferenceChip } from "./LiveReferenceChip";

export function ExecutionRefChip({
  attrs,
  selected,
  onRemove,
}: {
  attrs: ExecutionRefAttrs;
  selected?: boolean;
  onRemove?(): void;
}): React.JSX.Element {
  return (
    <LiveReferenceChip
      target={{
        kind: "execution",
        projectName: attrs["project-name"],
        sessionName: attrs["session-name"],
        id: attrs["execution-id"],
      }}
      title={attrs.title}
      identity={attrs["execution-id"]}
      selected={selected}
      onRemove={onRemove}
      reference={buildExecutionRefXml({
        projectName: attrs["project-name"],
        sessionName: attrs["session-name"],
        executionId: attrs["execution-id"],
        title: attrs.title,
      })}
    />
  );
}

export function ExecutionRefEditorChip({
  node,
  selected,
  deleteNode,
}: ReactNodeViewProps<HTMLElement>): React.JSX.Element {
  const attrs = executionRefAttrsSchema.parse(node.attrs);
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <ExecutionRefChip
        attrs={attrs}
        selected={selected}
        onRemove={deleteNode}
      />
    </NodeViewWrapper>
  );
}
