import { useMemo } from "react";
import { isOutputSchemaSaveBlocked } from "@/components/workflow-config-panel/affordance";
import { describeOutputSchemaRefusal } from "@/components/workflow-config/OutputSchemaField";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";

/**
 * The builder's pending output-schema editor text, keyed by context.
 *
 * The store can only hold a PARSED document, so text the engine's supported
 * subset refuses never reaches it and `dirty` cannot see it. The panel screen
 * holding that text is unmounted by every deep link, rail collapse and
 * selection change, so the text cannot live there either — it lives with the
 * draft, and this module is the one place that decides what the editor shows
 * and whether the draft is still committable.
 */
export interface OutputSchemaDraftEntry {
  text: string;
  /**
   * The serialization the draft holds BECAUSE of this text. Comparing the
   * incoming persisted value against this — not against `text` — is what lets
   * the entry survive a remount without reformatting the author's own
   * keystrokes, and what makes it stale the moment the draft moves on its own.
   */
  committed: string;
}

export type OutputSchemaDrafts = Readonly<
  Record<string, OutputSchemaDraftEntry>
>;

/**
 * The refused output-schema text, named so the toolbar can list it beside the
 * definition validator's own errors and deep-link back to the editor holding it.
 */
export interface BuilderOutputSchemaBlock {
  contextId: string;
  /** The editor's own refusal copy, never a restatement of it. */
  message: string;
}

export function serializeOutputSchemaText(
  schema: Record<string, unknown> | undefined,
): string {
  return schema ? JSON.stringify(schema, null, 2) : "";
}

/** What the editor for one context shows, given what the draft holds. */
export function resolveOutputSchemaText(
  persistedText: string,
  entry: OutputSchemaDraftEntry | undefined,
): string {
  if (entry === undefined || entry.committed !== persistedText) {
    return persistedText;
  }
  return entry.text;
}

/**
 * Every context whose pending text no commit could accept, in draft order.
 * Scanning every context — not just the selected one — is the point: leaving
 * the screen is not a fix. Each entry owes the author its own row, so a draft
 * refused in two places names both rather than revealing the second only once
 * the first is repaired.
 */
export function findOutputSchemaBlocks(
  definition: WorkflowSemanticDefinition | null,
  drafts: OutputSchemaDrafts,
): BuilderOutputSchemaBlock[] {
  if (definition === null) return [];
  const blocks: BuilderOutputSchemaBlock[] = [];
  for (const context of definition.executionContexts) {
    const text = resolveOutputSchemaText(
      serializeOutputSchemaText(context.outputSchema),
      drafts[context.id],
    );
    if (!isOutputSchemaSaveBlocked(text)) continue;
    const message = describeOutputSchemaRefusal(text);
    if (message === null) continue;
    blocks.push({ contextId: context.id, message });
  }
  return blocks;
}

/**
 * The live verdict over the loaded draft. The toolbar's save gate, its
 * validation strip and the definitions sidebar's unsaved marker all hang off
 * it, and they must agree — so they read it here rather than each deciding for
 * themselves.
 */
export function useOutputSchemaBlocks(): BuilderOutputSchemaBlock[] {
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (state) => state.draftDefinition,
  );
  const drafts = _useGraphWorkflowBuilderStore(
    (state) => state.pendingOutputSchemaText,
  );
  return useMemo(
    () => findOutputSchemaBlocks(draftDefinition, drafts),
    [draftDefinition, drafts],
  );
}
