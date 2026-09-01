"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { FormInput, FormLabel } from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";

export interface WorkflowBuilderInspectorRailProps {
  management: NativeSddWorkflowManagementDetail;
  config: ReactNode;
  onReaffirm?: (
    criterionElementIds: readonly string[],
    expectedBindingRevision: number,
  ) => void;
  reaffirming?: boolean;
  error?: string | null;
  onComment?: (input: { contextId: string; body: string }) => void;
  commenting?: boolean;
}

export default function WorkflowBuilderInspectorRail({
  management,
  config,
  onReaffirm,
  reaffirming = false,
  error = null,
  onComment,
  commenting = false,
}: WorkflowBuilderInspectorRailProps): React.JSX.Element {
  const [selection, setSelection] = useState(() => ({
    bindingRevision: management.bindingRevision,
    criterionIds: new Set<string>(),
  }));
  if (selection.bindingRevision !== management.bindingRevision) {
    setSelection({
      bindingRevision: management.bindingRevision,
      criterionIds: new Set(),
    });
  }
  const [commentContextId, setCommentContextId] = useState(
    management.binding.claims[0]?.contextId ?? "",
  );
  const [commentBody, setCommentBody] = useState("");
  const setHighlightedContextIds = _useGraphWorkflowBuilderStore(
    (state) => state.setHighlightedContextIds,
  );

  const changeRows = [
    ["Workflow settings", management.changes.workflowSettings],
    ["Contexts", management.changes.contexts],
    ["Tasks", management.changes.tasks],
    ["Edges / layout", management.changes.edges || management.changes.layout],
    ["Dispositions", management.changes.dispositions],
    ["Claims", management.changes.claims],
  ] as const;

  return (
    <TabsRoot
      defaultValue="config"
      layoutClassName="flex min-h-0 flex-1 flex-col"
      onValueChange={(value) => {
        if (value === "config") setHighlightedContextIds([]);
      }}
    >
      <TabsList aria-label="Managed delivery inspector" layoutClassName="m-sm">
        <TabsTrigger value="config" fill layoutClassName="flex-1">
          Config
        </TabsTrigger>
        <TabsTrigger value="scope" fill layoutClassName="flex-1">
          Scope
        </TabsTrigger>
        <TabsTrigger value="changes" fill layoutClassName="flex-1">
          Changes
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="config"
        layoutClassName="min-h-0 flex-1 overflow-y-auto"
      >
        {config}
      </TabsContent>

      <TabsContent
        value="scope"
        layoutClassName="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-md px-md pb-md">
          <div className="flex flex-wrap gap-xs">
            {Object.entries(management.dispositionCounts).map(
              ([disposition, count]) => (
                <StatusChip key={disposition} tone="neutral">
                  {disposition.replaceAll("_", " ")} {count}
                </StatusChip>
              ),
            )}
          </div>

          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {management.criterionRows.map((criterion) => {
              const pending = criterion.disposition === "pending_reaffirmation";
              return (
                <li
                  key={criterion.criterionElementId}
                  className="rounded-md border border-solid border-border-subtle bg-bg-raised p-sm"
                >
                  <div className="flex items-start gap-xs">
                    {pending && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${criterion.handle}`}
                        checked={selection.criterionIds.has(
                          criterion.criterionElementId,
                        )}
                        onChange={(event) => {
                          setSelection((current) => {
                            const next = new Set(current.criterionIds);
                            if (event.target.checked) {
                              next.add(criterion.criterionElementId);
                            } else {
                              next.delete(criterion.criterionElementId);
                            }
                            return { ...current, criterionIds: next };
                          });
                        }}
                      />
                    )}
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-[0.72rem] leading-relaxed text-text-primary hover:text-cyan"
                      onClick={() =>
                        setHighlightedContextIds(criterion.contextIds)
                      }
                    >
                      {criterion.handle} {criterion.text}
                    </button>
                    <StatusChip tone={pending ? "amber" : "neutral"}>
                      {criterion.disposition.replaceAll("_", " ")}
                    </StatusChip>
                  </div>
                  {criterion.contextIds.length > 0 && (
                    <div className="mt-xs flex flex-wrap gap-xs">
                      {criterion.contextIds.map((contextId) => (
                        <StatusChip
                          key={contextId}
                          as="button"
                          tone="cyan"
                          onClick={() => setHighlightedContextIds([contextId])}
                        >
                          {contextId}
                        </StatusChip>
                      ))}
                    </div>
                  )}
                  {criterion.deliveredByExecutionId && (
                    <p className="mt-xs mb-0 font-mono text-[0.66rem] text-text-tertiary">
                      delivered by {criterion.deliveredByExecutionId}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          {management.unresolvedItems.length > 0 && onReaffirm && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={reaffirming}
              disabled={selection.criterionIds.size === 0}
              onClick={() =>
                onReaffirm(
                  [...selection.criterionIds],
                  management.bindingRevision,
                )
              }
            >
              Reaffirm selected
            </Button>
          )}

          <section aria-label="Binding comments">
            <h3 className="mt-0 mb-xs font-mono text-[0.7rem] font-semibold tracking-wide text-text-secondary uppercase">
              Comments
            </h3>
            {management.comments.length === 0 ? (
              <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                No comments on this attempt.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-xs p-0">
                {management.comments.map((comment) => (
                  <li
                    key={comment.id}
                    className="font-mono text-[0.68rem] text-text-secondary"
                  >
                    <span className="text-text-tertiary">
                      {comment.contextId}
                      {comment.orphaned ? " · orphaned" : ""}
                    </span>{" "}
                    {comment.body}
                  </li>
                ))}
              </ul>
            )}
            {onComment && management.binding.claims.length > 0 && (
              <form
                className="mt-sm flex flex-col gap-xs"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = commentBody.trim();
                  if (!body || !commentContextId) return;
                  onComment({ contextId: commentContextId, body });
                  setCommentBody("");
                }}
              >
                <FormLabel htmlFor="managed-comment-context">
                  Accountability source
                </FormLabel>
                <Select
                  value={commentContextId}
                  onValueChange={setCommentContextId}
                >
                  <SelectTrigger
                    id="managed-comment-context"
                    aria-label="Accountability source"
                    layoutClassName="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {management.binding.claims.map(({ contextId }) => (
                      <SelectItem key={contextId} value={contextId}>
                        {contextId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormLabel htmlFor="managed-comment-body">Comment</FormLabel>
                <FormInput
                  id="managed-comment-body"
                  value={commentBody}
                  onChange={(event) => setCommentBody(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  loading={commenting}
                  disabled={commentBody.trim().length === 0}
                >
                  Comment
                </Button>
              </form>
            )}
          </section>

          {error && (
            <p role="alert" className="m-0 font-mono text-[0.68rem] text-red">
              {error}
            </p>
          )}
        </div>
      </TabsContent>

      <TabsContent
        value="changes"
        layoutClassName="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="px-md pb-md">
          {management.approvedBaseline === null ? (
            <p className="font-mono text-[0.72rem] text-text-secondary">
              No approved delivery baseline yet.
            </p>
          ) : (
            <p className="font-mono text-[0.72rem] text-text-secondary">
              Approved baseline{" "}
              {management.approvedBaseline.workflowDefinition.id}
              {" · r"}
              {management.approvedBaseline.workflowDefinition.revision}
            </p>
          )}
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {changeRows.map(([label, changed]) => (
              <li
                key={label}
                aria-label={`${label} ${changed ? "Changed" : "Unchanged"}`}
                className="flex items-center justify-between rounded-md border border-solid border-border-subtle bg-bg-raised px-sm py-xs font-mono text-[0.72rem]"
              >
                <span>{label}</span>
                <StatusChip tone={changed ? "amber" : "neutral"}>
                  {changed ? "Changed" : "Unchanged"}
                </StatusChip>
              </li>
            ))}
          </ul>
        </div>
      </TabsContent>
    </TabsRoot>
  );
}
