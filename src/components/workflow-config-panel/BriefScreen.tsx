"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/AlertDialog";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
import { isConfigLocked } from "./affordance";
import {
  ConfigDangerButton,
  ConfigItemList,
  ConfigTextArea,
  ConfigTextInput,
  type ConfigListItem,
} from "./ConfigControls";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";
import {
  criteriaRecords,
  moveItem,
  nextCriterionId,
  removeItem,
} from "./ordered-edits";
import { IDENTITY_PROVENANCE } from "./row-provenance";
import { outputSchemaRowParts } from "./schema-lint";
import type { ContextStructuralEditor } from "./structural-editor";
import { chipPart, textPart, type ConfigValuePart } from "./value-parts";

/**
 * Brief — what this context is for and what it owes (Config Panel
 * `briefRows()`). Identity, the ordered acceptance criteria every validator
 * seat cites, the read-only data contract, and — on the builder alone — the
 * delete that only a draft can offer.
 *
 * Nothing here is cascade configuration: a brief has no tier above it to
 * inherit from, so no row wears a provenance chip or a reset.
 */

const CRITERIA_HINT =
  "Ordered. Passed to the implementer and to every validator seat; verdicts cite criterion ids.";

const UPSTREAM_HINT =
  "Read-only — produced by the contexts this one depends on.";

const DELETE_HINT =
  "Removes this context, its tasks and its edges from the draft. Confirmed in a dialog; takes effect on Save.";

/** The declared fields a predecessor will hand over, as chips. */
function upstreamChips(input: GraphWorkflowUpstreamInput): ConfigValuePart[] {
  if (!input.declared) return [textPart("free-form", "dim")];
  const fields = input.schemaFields ?? [];
  // A declared contract need not name top-level fields (a bare object, a root
  // `oneOf`), and calling that free-form would be the opposite of what it is.
  if (fields.length === 0) return [textPart("declared", "dim")];
  return fields.map((field) => chipPart(field.name));
}

function upstreamItems(
  inputs: readonly GraphWorkflowUpstreamInput[],
): ConfigListItem[] {
  return inputs.map((input) => ({
    id: input.contextId,
    title: input.title,
    chips: upstreamChips(input),
  }));
}

export interface BriefScreenProps {
  editor: ContextStructuralEditor;
  /** Push the Output schema screen — the panel owns the navigation stack. */
  onOpenSchema: () => void;
}

export function BriefScreen({
  editor,
  onOpenSchema,
}: BriefScreenProps): React.JSX.Element {
  const { context, onContextChange } = editor;
  const locked = isConfigLocked(editor.affordance);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const criteria = criteriaRecords(context.acceptanceCriteria);

  function edit(patch: Partial<GraphWorkflowExecutionContextDefinition>): void {
    // Spread the whole context, never rebuild it: every field no screen in this
    // panel authors has to survive the write untouched (README §6).
    onContextChange({ ...context, ...patch });
  }

  function editCriteria(next: readonly { id: string; statement: string }[]) {
    edit({ acceptanceCriteria: next.map((record) => ({ ...record })) });
  }

  /**
   * Apply a prose edit AND submit it in one act. The next context is handed to
   * the host rather than left to be read back from state, because the value a
   * stop-and-submit dictation delivers has not reached the host yet.
   */
  function submit(patch: Partial<GraphWorkflowExecutionContextDefinition>) {
    const next = { ...context, ...patch };
    onContextChange(next);
    editor.onRequestSave?.(next);
  }

  function submitCriteria(next: readonly { id: string; statement: string }[]) {
    submit({ acceptanceCriteria: next.map((record) => ({ ...record })) });
  }

  const criterionItems: ConfigListItem[] = criteria.map((record, index) => ({
    id: record.id,
    title: record.id,
    onMoveUp:
      index === 0
        ? undefined
        : () => editCriteria(moveItem(criteria, index, index - 1)),
    onMoveDown:
      index === criteria.length - 1
        ? undefined
        : () => editCriteria(moveItem(criteria, index, index + 1)),
    onRemove: () => editCriteria(removeItem(criteria, index)),
    // A context with no acceptance criteria is not a legal declaration, so the
    // last one is held rather than silently re-added on save.
    removeDisabled: criteria.length <= 1,
    children: (
      <ConfigTextArea
        value={record.statement}
        onChange={(statement) =>
          editCriteria(
            criteria.map((each, at) =>
              at === index ? { ...each, statement } : each,
            ),
          )
        }
        ariaLabel={`Statement for ${record.id}`}
        rows={2}
        placeholder="What this criterion requires"
        disabled={locked}
        onPrimaryAction={(statement) =>
          submitCriteria(
            criteria.map((each, at) =>
              at === index ? { ...each, statement } : each,
            ),
          )
        }
      />
    ),
  }));

  return (
    <>
      <ConfigRowGroup label="Identity">
        <ConfigControlRow
          rowId="brief-title"
          label="Title"
          control={
            <ConfigTextInput
              value={context.title}
              onChange={(title) => edit({ title })}
              ariaLabel="Context title"
              placeholder="Context title"
              disabled={locked}
            />
          }
        />
        <ConfigControlRow
          rowId="brief-description"
          label="Description"
          disabled={locked}
        >
          <ConfigTextArea
            value={context.description ?? ""}
            onChange={(description) => edit({ description })}
            ariaLabel="Context description"
            rows={4}
            placeholder="Add a description"
            disabled={locked}
            onPrimaryAction={(description) => submit({ description })}
          />
        </ConfigControlRow>
      </ConfigRowGroup>

      <ConfigRowGroup label="Acceptance criteria">
        <ConfigControlRow
          rowId="brief-criteria"
          label="Acceptance criteria"
          hint={CRITERIA_HINT}
          disabled={locked}
        >
          <ConfigItemList
            items={criterionItems}
            disabled={locked}
            {...(locked
              ? {}
              : {
                  addLabel: "Add criterion",
                  onAdd: () =>
                    editCriteria([
                      ...criteria,
                      { id: nextCriterionId(criteria), statement: "" },
                    ]),
                })}
          />
        </ConfigControlRow>
      </ConfigRowGroup>

      <ConfigRowGroup label="Data contract">
        <ConfigDrillRow
          screenId="schema"
          label="Output schema"
          parts={outputSchemaRowParts(editor.outputSchemaText)}
          provenance={IDENTITY_PROVENANCE}
          onOpen={onOpenSchema}
        />
        <ConfigControlRow
          rowId="brief-upstream"
          label="Upstream inputs"
          hint={UPSTREAM_HINT}
        >
          {editor.upstreamInputs.length === 0 ? (
            <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
              No upstream contexts feed this one.
            </p>
          ) : (
            <ConfigItemList items={upstreamItems(editor.upstreamInputs)} />
          )}
        </ConfigControlRow>
      </ConfigRowGroup>

      {editor.host === "builder" && editor.onDeleteContext ? (
        <ConfigRowGroup label="Danger zone">
          <ConfigControlRow
            rowId="brief-delete"
            label="Delete context"
            hint={DELETE_HINT}
            disabled={locked}
          >
            <ConfigDangerButton
              label="Delete context"
              onClick={() => setConfirmingDelete(true)}
              disabled={locked}
            />
          </ConfigControlRow>
        </ConfigRowGroup>
      ) : null}

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete “{context.title}”?</AlertDialogTitle>
          <AlertDialogDescription>{DELETE_HINT}</AlertDialogDescription>
          <AlertDialogActions>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction danger onClick={editor.onDeleteContext}>
              Delete context
            </AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
