"use client";

import { useState } from "react";

import { agentProfileTierPresentation } from "@/components/agent-profiles/agent-profile-tier";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip } from "@/components/ui/StatusChip";
import { Tab, Tabs } from "@/components/ui/Tabs";
import {
  useCreateAgentProfileMutation,
  useDeleteAgentProfileMutation,
  useDuplicateAgentProfileMutation,
  useUpdateAgentProfileMutation,
} from "@/lib/agent-profiles/mutations";
import {
  useAgentProfileDeletionPreview,
  useProjectAgentProfile,
  useProjectAgentProfileLibrary,
} from "@/lib/agent-profiles/queries";
import {
  formatAgentProfileRef,
  type AgentProfileRef,
  type AgentProfileTier,
  type MutableAgentProfileTier,
} from "@/lib/agent-profiles/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

import AgentProfileEditor from "./AgentProfileEditor";
import {
  agentProfileDraftFromEntry,
  emptyAgentProfileDraft,
  type AgentProfileDraft,
} from "./agent-profile-draft";

/**
 * The three scopes a profile can live in, as tabs.
 *
 * D23 names the two authoring scopes; the read-only builtin scope is a tab too
 * because duplicate-to-edit is how a built-in becomes editable (R3.1) — a
 * management surface that could not show one would have no place to start that
 * from.
 */
const TIER_TABS: readonly AgentProfileTier[] = ["builtin", "global", "project"];

export interface AgentsLibraryPageProps {
  projectName: string;
}

interface EditorTarget {
  ref: AgentProfileRef | null;
  tier: MutableAgentProfileTier;
}

/**
 * The agent profile library's management surface.
 *
 * Listing, provenance, and invalidation all come from the library domain: the
 * listing is the combined scoped read, and no mutation here invalidates
 * anything, because `agent-profile-library-changed` already refreshes the
 * owning scope's queries for every client rather than just this one.
 */
export default function AgentsLibraryPage({
  projectName,
}: AgentsLibraryPageProps): React.JSX.Element {
  const [tier, setTier] = useState<AgentProfileTier>("builtin");
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [draft, setDraft] = useState<AgentProfileDraft>(emptyAgentProfileDraft);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const library = useProjectAgentProfileLibrary(projectName);
  const profiles = library.data?.profiles ?? [];
  const scoped = profiles.filter((profile) => profile.ref.tier === tier);

  // Only a record being edited needs its instructions: the authorized get is
  // the one surface that carries them (R6.3), so nothing prefetches a listing's
  // worth of them.
  const editing = useProjectAgentProfile(
    projectName,
    target?.ref?.tier ?? "builtin",
    target?.ref?.id ?? "",
  );
  const entry =
    target?.ref === undefined || target.ref === null
      ? null
      : (editing.data ?? null);

  // Scoped to the open dialog: the server scans the filesystem per call, and a
  // preview held while the dialog is closed would be a photograph of a moment
  // nobody is deciding in.
  const deletionPreview = useAgentProfileDeletionPreview(
    projectName,
    target?.ref?.tier ?? "builtin",
    target?.ref?.id ?? "",
    { enabled: confirmingDelete && target?.ref != null },
  );

  const createProfile = useCreateAgentProfileMutation(projectName);
  const updateProfile = useUpdateAgentProfileMutation(projectName);
  const deleteProfile = useDeleteAgentProfileMutation(projectName);
  const duplicateProfile = useDuplicateAgentProfileMutation(projectName);

  // The fetched record becomes the draft once, when it arrives for the record
  // the editor is pointed at — a state-during-render handover rather than an
  // effect, so an in-progress edit is never overwritten by a refetch.
  const [loadedRef, setLoadedRef] = useState<string | null>(null);
  const targetKey =
    target?.ref === null || target?.ref === undefined
      ? null
      : formatAgentProfileRef(target.ref);
  if (entry !== null && targetKey !== null && loadedRef !== targetKey) {
    setLoadedRef(targetKey);
    setDraft(agentProfileDraftFromEntry(entry));
  }

  const startCreate = (createTier: MutableAgentProfileTier) => {
    setServerError(null);
    setLoadedRef(null);
    setConfirmingDelete(false);
    setTarget({ ref: null, tier: createTier });
    setDraft(emptyAgentProfileDraft());
  };

  const startEdit = (ref: AgentProfileRef) => {
    setServerError(null);
    setLoadedRef(null);
    setConfirmingDelete(false);
    setTarget({
      ref,
      tier: ref.tier === "builtin" ? "project" : ref.tier,
    });
    setDraft(emptyAgentProfileDraft());
  };

  const closeEditor = () => {
    setTarget(null);
    setLoadedRef(null);
    setServerError(null);
    setConfirmingDelete(false);
  };

  const failWith = (error: unknown) => setServerError(getErrorMessage(error));

  const tierLabel = agentProfileTierPresentation(tier).label;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-md overflow-auto p-lg">
      <header className="flex flex-wrap items-center justify-between gap-sm">
        <h1 className="m-0 font-mono text-[1rem] font-semibold text-text-primary">
          Agents
        </h1>
        <div className="flex gap-sm">
          <Button size="sm" onClick={() => startCreate("global")}>
            New global profile
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => startCreate("project")}
          >
            New project profile
          </Button>
        </div>
      </header>

      <Tabs role="tablist" aria-label="Profile scope">
        {TIER_TABS.map((entryTier) => (
          <Tab
            key={entryTier}
            role="tab"
            aria-selected={entryTier === tier}
            active={entryTier === tier}
            onClick={() => setTier(entryTier)}
          >
            {agentProfileTierPresentation(entryTier).label}
          </Tab>
        ))}
      </Tabs>

      {library.isError ? (
        <EmptyState>
          <EmptyStateTitle>Could not load the profile library</EmptyStateTitle>
          <EmptyStateDesc>{getErrorMessage(library.error)}</EmptyStateDesc>
        </EmptyState>
      ) : scoped.length === 0 ? (
        <EmptyState>
          <EmptyStateTitle>
            No {tierLabel.toLowerCase()} profiles
          </EmptyStateTitle>
          <EmptyStateDesc>
            {tier === "builtin"
              ? "Built-in profiles ship with Command Center."
              : `Create one, or duplicate a profile into the ${tierLabel.toLowerCase()} tier.`}
          </EmptyStateDesc>
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs p-0">
          {scoped.map((profile) => (
            <li key={formatAgentProfileRef(profile.ref)}>
              <button
                type="button"
                aria-label={`Edit ${profile.name}`}
                onClick={() => startEdit(profile.ref)}
                className="flex w-full cursor-pointer flex-col items-start gap-2xs rounded-md border border-solid border-border-subtle bg-bg-surface p-sm text-left transition-colors duration-150 hover:border-border-strong hover:bg-bg-hover"
              >
                <span className="flex flex-wrap items-center gap-xs">
                  <span className="font-mono text-[0.82rem] font-semibold text-text-primary">
                    {profile.name}
                  </span>
                  <StatusChip
                    tone={agentProfileTierPresentation(profile.ref.tier).tone}
                    appearance="flat"
                  >
                    {agentProfileTierPresentation(profile.ref.tier).label}
                  </StatusChip>
                  {profile.readOnly && (
                    <StatusChip tone="neutral">Read-only</StatusChip>
                  )}
                </span>
                <span className="font-mono text-[0.72rem] text-text-tertiary">
                  {profile.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {library.data !== undefined && library.data.diagnostics.length > 0 && (
        <ul
          aria-label="Unreadable profiles"
          className="m-0 flex list-none flex-col gap-2xs p-0"
        >
          {library.data.diagnostics.map((diagnostic) => (
            <li
              key={`${diagnostic.tier}:${diagnostic.id}`}
              className="rounded-md border border-solid border-amber-dim bg-amber-glow p-sm font-mono text-[0.72rem] text-amber"
            >
              {diagnostic.tier}:{diagnostic.id} — {diagnostic.reason}
            </li>
          ))}
        </ul>
      )}

      {target !== null && (
        <section
          aria-label="Profile editor"
          className="flex flex-col gap-sm rounded-md border border-solid border-border-default bg-bg-surface p-md"
        >
          <div className="flex items-center justify-between gap-sm">
            <h2 className="m-0 font-mono text-[0.86rem] font-semibold text-text-primary">
              {target.ref === null ? "New profile" : draft.name || "Profile"}
            </h2>
            <Button size="sm" variant="ghost" onClick={closeEditor}>
              Close
            </Button>
          </div>
          <AgentProfileEditor
            draft={draft}
            onDraftChange={setDraft}
            ref_={target.ref}
            targetTier={target.tier}
            revision={entry?.revision ?? null}
            readOnly={target.ref?.tier === "builtin"}
            saving={createProfile.isPending || updateProfile.isPending}
            serverError={serverError}
            onSave={(content) => {
              setServerError(null);
              if (target.ref === null) {
                createProfile.mutate(
                  { tier: target.tier, content },
                  { onSuccess: closeEditor, onError: failWith },
                );
                return;
              }
              if (entry === null) return;
              updateProfile.mutate(
                {
                  ref: target.ref,
                  expectedRevision: entry.revision,
                  content,
                },
                { onSuccess: closeEditor, onError: failWith },
              );
            }}
            onDuplicate={(targetTier) => {
              if (target.ref === null) return;
              setServerError(null);
              duplicateProfile.mutate(
                { source: target.ref, targetTier },
                {
                  onSuccess: (item) => {
                    setTier(item.ref.tier);
                    startEdit(item.ref);
                  },
                  onError: failWith,
                },
              );
            }}
            confirmingDelete={confirmingDelete}
            onConfirmingDeleteChange={setConfirmingDelete}
            // The adapter from query state to view state, and the one place
            // the invariant "a report and an error are never both present" is
            // established — the query itself does NOT guarantee it. React
            // Query retains the last successful `data` through a failed
            // refetch, so a reopen whose scan fails carries the previous
            // open's report alongside the new error.
            //
            // `isFetching`, not `isPending`, for the same reason: reopening
            // re-runs the scan, and the previous open's holders shown during
            // that refetch would be a stale answer to a question already being
            // re-asked. Either way the rule is the same — a report is only
            // shown, and only counts as shown, while it is the CURRENT answer.
            deletionPreview={{
              isPending: deletionPreview.isFetching,
              error: deletionPreview.error,
              report:
                deletionPreview.isFetching || deletionPreview.error !== null
                  ? null
                  : (deletionPreview.data ?? null),
            }}
            onDelete={() => {
              if (target.ref === null || entry === null) return;
              setServerError(null);
              deleteProfile.mutate(
                { ref: target.ref, expectedRevision: entry.revision },
                { onSuccess: closeEditor, onError: failWith },
              );
            }}
          />
        </section>
      )}
    </div>
  );
}
