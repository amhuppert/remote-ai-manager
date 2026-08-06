"use client";

import { useId, useMemo } from "react";

import { agentProfileTierPresentation } from "@/components/agent-profiles/agent-profile-tier";
import { MultilineInput } from "@/components/MultilineInput";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  deriveAgentProfileId,
  type AgentProfileAudience,
  type AgentProfileContent,
  type AgentProfileDeletionReport,
  type AgentProfileRef,
  type AgentProfileTier,
  type MutableAgentProfileTier,
} from "@/lib/agent-profiles/schemas";

import {
  previewAgentProfileBlock,
  validateAgentProfileDraft,
  type AgentProfileDraft,
} from "./agent-profile-draft";
import AgentProfileDeletionImpact from "./AgentProfileDeletionImpact";

const AUDIENCES: readonly { value: AgentProfileAudience; label: string }[] = [
  { value: "conversation", label: "Conversations" },
  { value: "workflow_implementer", label: "Workflow implementers" },
  { value: "workflow_validator", label: "Workflow validators" },
];

export interface AgentProfileEditorProps {
  draft: AgentProfileDraft;
  onDraftChange: (draft: AgentProfileDraft) => void;
  /** Absent while creating: the record does not exist yet. */
  ref_: AgentProfileRef | null;
  /** Where a create would land. Ignored once `ref_` names a record. */
  targetTier: MutableAgentProfileTier;
  /** The revision an update must expect; absent while creating. */
  revision: number | null;
  readOnly: boolean;
  saving: boolean;
  onSave: (content: AgentProfileContent) => void;
  onDuplicate: (targetTier: MutableAgentProfileTier) => void;
  onDelete: () => void;
  /**
   * The confirmation dialog's open state, owned by the page so opening it is
   * what runs the deletion preview query.
   */
  confirmingDelete: boolean;
  onConfirmingDeleteChange: (open: boolean) => void;
  /**
   * The preview for the open dialog; `report` is null until it arrives.
   *
   * A non-null `report` is only trusted together with a null `error`. The two
   * can arrive together — a failed refetch keeps the last successful data — and
   * this component does not assume the caller has already reconciled them.
   */
  deletionPreview: {
    isPending: boolean;
    error: Error | null;
    report: AgentProfileDeletionReport | null;
  };
  /** A refusal the server returned — surfaced verbatim, never re-worded. */
  serverError: string | null;
}

/**
 * The authoring form for one profile, with the composed prompt it produces.
 *
 * Validation runs on every keystroke against the domain schema itself rather
 * than a parallel set of form rules, so the editor cannot drift from what the
 * library will accept; the server's refusal stays the authority and is shown
 * verbatim when it disagrees.
 *
 * The preview runs the real composer against a stub identity — the frame an
 * author sees is byte-for-byte the frame a backend receives, minus provenance a
 * draft cannot have yet.
 */
export default function AgentProfileEditor({
  draft,
  onDraftChange,
  ref_,
  targetTier,
  revision,
  readOnly,
  saving,
  onSave,
  onDuplicate,
  onDelete,
  confirmingDelete,
  onConfirmingDeleteChange,
  deletionPreview,
  serverError,
}: AgentProfileEditorProps): React.JSX.Element {
  const fieldId = useId();

  const validation = useMemo(() => validateAgentProfileDraft(draft), [draft]);
  const errors = validation.ok ? {} : validation.errors;

  // A create previews at the revision it will be created as, and an id derived
  // from the name — the same default the library applies.
  const identityTier: AgentProfileTier = ref_?.tier ?? targetTier;
  const identityId = ref_?.id ?? deriveAgentProfileId(draft.name);
  const preview = previewAgentProfileBlock(draft, {
    tier: identityTier,
    id: identityId.length > 0 ? identityId : "unnamed-profile",
    revision: revision === null ? 1 : revision + 1,
  });

  const patch = (next: Partial<AgentProfileDraft>) =>
    onDraftChange({ ...draft, ...next });

  const toggleAudience = (audience: AgentProfileAudience, on: boolean) =>
    patch({
      recommendedFor: on
        ? [...draft.recommendedFor, audience]
        : draft.recommendedFor.filter((entry) => entry !== audience),
    });

  return (
    <div className="flex min-w-0 flex-col gap-md">
      <FormGroup>
        <FormLabel htmlFor={`${fieldId}-name`}>Name</FormLabel>
        <FormInput
          id={`${fieldId}-name`}
          value={draft.name}
          disabled={readOnly}
          onChange={(event) => patch({ name: event.target.value })}
        />
        {errors.name !== undefined && <FormError>{errors.name}</FormError>}
        <FormHint>
          {ref_ === null ? (
            <>
              Identifier: <code>{identityId || "—"}</code> (immutable once
              created)
            </>
          ) : (
            <>
              Identifier: <code>{ref_.id}</code> in the{" "}
              {agentProfileTierPresentation(ref_.tier).label.toLowerCase()} tier
            </>
          )}
        </FormHint>

        <FormLabel htmlFor={`${fieldId}-description`} layoutClassName="mt-sm">
          Description
        </FormLabel>
        <FormInput
          id={`${fieldId}-description`}
          value={draft.description}
          disabled={readOnly}
          onChange={(event) => patch({ description: event.target.value })}
        />
        {errors.description !== undefined && (
          <FormError>{errors.description}</FormError>
        )}
        <FormHint>
          Planning agents staff assignments by reading this, so say what the
          profile is for.
        </FormHint>

        <FormLabel htmlFor={`${fieldId}-instructions`} layoutClassName="mt-sm">
          Instructions
        </FormLabel>
        <MultilineInput
          id={`${fieldId}-instructions`}
          rows={8}
          value={draft.instructions}
          disabled={readOnly}
          onValueChange={(instructions) => patch({ instructions })}
        />
        {errors.instructions !== undefined && (
          <FormError>{errors.instructions}</FormError>
        )}

        <FormLabel layoutClassName="mt-sm">Recommended for</FormLabel>
        <div className="flex flex-wrap gap-md">
          {AUDIENCES.map((audience) => (
            <CheckboxField
              key={audience.value}
              id={`${fieldId}-${audience.value}`}
              label={audience.label}
              checked={draft.recommendedFor.includes(audience.value)}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                toggleAudience(audience.value, checked === true)
              }
            />
          ))}
        </div>
        <FormHint>
          Advisory only — pickers warn on a mismatch and never refuse one.
        </FormHint>

        <FormLabel htmlFor={`${fieldId}-tags`} layoutClassName="mt-sm">
          Tags
        </FormLabel>
        <FormInput
          id={`${fieldId}-tags`}
          value={draft.tagsText}
          disabled={readOnly}
          placeholder="review, security"
          onChange={(event) => patch({ tagsText: event.target.value })}
        />
        {errors.tags !== undefined && <FormError>{errors.tags}</FormError>}
      </FormGroup>

      <section className="flex flex-col gap-2xs">
        <div className="flex items-center gap-xs">
          <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Composed prompt
          </span>
          <StatusChip
            tone={agentProfileTierPresentation(identityTier).tone}
            appearance="flat"
          >
            {agentProfileTierPresentation(identityTier).label}
          </StatusChip>
        </div>
        {preview === null ? (
          <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
            Add a name and instructions to see the composed prompt.
          </p>
        ) : (
          <pre
            aria-label="Composed prompt preview"
            className="m-0 max-h-[280px] overflow-auto rounded-md border border-solid border-border-subtle bg-bg-base p-sm font-mono text-[0.72rem] leading-[1.5] whitespace-pre-wrap text-text-secondary"
          >
            {preview}
          </pre>
        )}
      </section>

      {serverError !== null && (
        <FormError role="alert">{serverError}</FormError>
      )}

      <div className="flex flex-wrap items-center gap-sm">
        {!readOnly && (
          <Button
            variant="primary"
            size="sm"
            disabled={!validation.ok || saving}
            onClick={() => {
              if (validation.ok) onSave(validation.content);
            }}
          >
            {saving ? "Saving…" : ref_ === null ? "Create profile" : "Save"}
          </Button>
        )}
        {ref_ !== null && (
          <>
            <Button size="sm" onClick={() => onDuplicate("global")}>
              Duplicate to global
            </Button>
            <Button size="sm" onClick={() => onDuplicate("project")}>
              Duplicate to project
            </Button>
          </>
        )}
        {ref_ !== null && !readOnly && (
          <>
            <Button
              size="sm"
              variant="danger"
              onClick={() => onConfirmingDeleteChange(true)}
            >
              Delete
            </Button>
            {/* The dialog IS the server's `confirm` flag: nothing is sent until
                it is answered, and the request carries the confirmation the
                route refuses to infer. Opening it is also what runs the
                read-only preview, so the holders are on screen before the
                confirmation is given rather than in the report after it. */}
            <AlertDialog
              open={confirmingDelete}
              onOpenChange={onConfirmingDeleteChange}
            >
              <AlertDialogContent>
                <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Conversations already running under this profile keep their
                  own snapshot and are unaffected — they persist the composed
                  profile, not a reference to it.
                </AlertDialogDescription>
                <AgentProfileDeletionImpact preview={deletionPreview} />
                <AlertDialogActions>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  {/* Held shut until the enumeration is actually ON SCREEN.
                      The list is advisory about its CONTENT — finding holders
                      never vetoes a deletion — but R15.1 puts it "before
                      confirmation", and a button live while the scan is in
                      flight lets a fast human confirm having been shown
                      nothing. A failed scan stays shut for a harder reason:
                      delete() runs the same enumeration server-side before
                      removing anything and refuses when it throws, so an
                      enabled button would promise an outcome the backend would
                      not honour. `loading` rather than a bare `disabled` while
                      pending because the Button primitive renders no disabled
                      affordance — the spinner is what makes the wait legible.

                      The error is checked ALONGSIDE the report, not instead of
                      it: a reopen whose refetch fails arrives holding the
                      previous open's report AND the new error, and a report the
                      panel is refusing to display has not been shown to
                      anyone. */}
                  <AlertDialogAction
                    danger
                    onClick={onDelete}
                    loading={deletionPreview.isPending}
                    disabled={
                      deletionPreview.report === null ||
                      deletionPreview.error !== null
                    }
                  >
                    Delete profile
                  </AlertDialogAction>
                </AlertDialogActions>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
        {readOnly && (
          <FormHint layoutClassName="m-0">
            Built-in profiles are read-only. Duplicate one to edit it.
          </FormHint>
        )}
      </div>
    </div>
  );
}
