"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "@/components/icons";
import {
  railOverlayPanelClass,
  RailOverlaySpacer,
} from "@/components/workflow-graph/RailOverlay";
import { useWorkflowRailCollapse } from "@/components/workflow-graph/useWorkflowRailCollapse";
import { cn } from "@/lib/ui/cn";
import type { NativeSddWorkflowManagementCompact } from "@/lib/workflow-graph/managed-definition";
import { useState } from "react";

const WB_BTN_BASE =
  "inline-flex items-center justify-center gap-[6px] whitespace-nowrap cursor-pointer rounded-sm border border-solid border-border-default font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";
const WB_BTN_XS =
  "h-[24px] px-[8px] py-[3px] text-[0.7rem] max-768:h-auto max-768:min-h-[44px]";
const WB_BTN_DEFAULT =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:border-border-strong hover:text-text-primary";
const WB_ICON_BTN = cn(
  WB_BTN_BASE,
  WB_BTN_DEFAULT,
  "size-[24px] flex-shrink-0 p-0",
);

const ROW_BASE =
  "flex w-full cursor-pointer appearance-none flex-col gap-[4px] rounded-md border border-solid px-[11px] py-[9px] text-left font-[inherit] transition-all duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]";
const ROW_IDLE =
  "border-border-subtle bg-bg-surface hover:border-border-strong hover:bg-bg-elevated";
const ROW_ACTIVE = "border-[var(--cc-cyan-a40)] bg-[var(--cc-cyan-a08)]";

interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  revision: number;
  /**
   * How many execution contexts the definition holds. The list endpoint returns
   * a body-less summary, so this arrives from the per-definition detail records
   * the page reads; a row whose record has not landed yet states its revision
   * alone rather than guessing a count.
   */
  contextCount?: number | null;
  updatedAt?: string;
  management?: NativeSddWorkflowManagementCompact;
}

interface WorkflowDefinitionsSidebarProps {
  definitions: WorkflowDefinitionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  isLoading: boolean;
  /** True while the create-definition mutation is in flight. */
  isCreating?: boolean;
  /**
   * The loaded draft has unsaved work — store edits, or editor text the draft
   * could not absorb. Only the selected row can carry it: the builder holds
   * exactly one draft, so a second row showing `unsaved` would claim an edit
   * that does not exist.
   */
  activeDraftDirty?: boolean;
  footer?: React.ReactNode;
  /** Heading shown above the list. Defaults to "Definitions". */
  title?: string;
}

function metaLine(
  definition: WorkflowDefinitionSummary,
  unsaved: boolean,
): string {
  const count = definition.contextCount;
  const parts = [`r${definition.revision}`];
  if (typeof count === "number") {
    parts.push(`${count} ${count === 1 ? "context" : "contexts"}`);
  }
  if (unsaved) parts.push("unsaved");
  return parts.join(" · ");
}

const MANAGED_LIFECYCLE_LABEL = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  launched: "Launched",
  superseded: "Superseded",
  abandoned: "Abandoned",
} as const;

function managedMetaLine(
  definition: WorkflowDefinitionSummary,
  unsaved: boolean,
): string {
  const management = definition.management;
  if (!management) return metaLine(definition, unsaved);
  const parts = [
    MANAGED_LIFECYCLE_LABEL[management.lifecycle],
    `spec r${management.pinnedRevisionNumber}`,
    metaLine(definition, unsaved),
  ];
  return parts.join(" · ");
}

interface ManagedDefinitionGroup {
  specId: string;
  specName: string;
  live: WorkflowDefinitionSummary[];
  past: WorkflowDefinitionSummary[];
}

function managedGroups(
  definitions: readonly WorkflowDefinitionSummary[],
): ManagedDefinitionGroup[] {
  const bySpec = new Map<string, WorkflowDefinitionSummary[]>();
  for (const definition of definitions) {
    const management = definition.management;
    if (!management) continue;
    const group = bySpec.get(management.specId) ?? [];
    group.push(definition);
    bySpec.set(management.specId, group);
  }

  return [...bySpec.entries()].map(([specId, candidates]) => {
    const current = candidates.find(
      ({ management }) => management?.isCurrentDefinition,
    );
    const latestLaunched = candidates
      .filter(({ management }) => management?.lifecycle === "launched")
      .sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
      )[0];
    const liveIds = new Set(
      [current?.id, latestLaunched?.id].filter(
        (id): id is string => id !== undefined,
      ),
    );
    return {
      specId,
      specName: candidates[0]?.management?.specName ?? specId,
      live: candidates.filter(({ id }) => liveIds.has(id)),
      past: candidates.filter(({ id }) => !liveIds.has(id)),
    };
  });
}

/** The strip's per-definition target: the name's first character, drawn large. */
function initialOf(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export default function WorkflowDefinitionsSidebar({
  definitions,
  selectedId,
  onSelect,
  onCreate,
  isLoading,
  isCreating = false,
  activeDraftDirty = false,
  footer,
  title = "Definitions",
}: WorkflowDefinitionsSidebarProps) {
  const { collapsed, setCollapsed, overlay } = useWorkflowRailCollapse();
  const [expandedPastSpecs, setExpandedPastSpecs] = useState<Set<string>>(
    () => new Set(),
  );
  const ordinaryDefinitions = definitions.filter(
    ({ management }) => management === undefined,
  );
  const specDeliveryGroups = managedGroups(definitions);

  const unsavedDot = (
    <span
      data-testid="definition-unsaved-dot"
      aria-hidden="true"
      className="size-[6px] flex-shrink-0 rounded-full bg-amber shadow-[0_0_4px_var(--amber-glow)]"
    />
  );

  if (collapsed) {
    return (
      <nav
        aria-label={title}
        className="flex w-[48px] min-w-[48px] flex-col items-center gap-[6px] overflow-hidden border-r border-solid border-border-subtle bg-bg-base py-[10px] max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow-builder][data-mobile-panel=inspector]_&]:hidden"
      >
        <button
          type="button"
          className={WB_ICON_BTN}
          onClick={() => setCollapsed(false)}
          aria-label={`Expand ${title.toLowerCase()} sidebar`}
          title={`Expand ${title.toLowerCase()} sidebar`}
        >
          <ChevronRightIcon size={13} />
        </button>
        <button
          type="button"
          className={WB_ICON_BTN}
          onClick={onCreate}
          disabled={isCreating}
          aria-busy={isCreating || undefined}
          aria-label="New workflow"
          title="New workflow"
        >
          <PlusIcon size={12} />
        </button>
        <div className="flex w-full flex-1 flex-col items-center gap-[6px] overflow-y-auto">
          {definitions.map((definition) => {
            const active = definition.id === selectedId;
            const unsaved = active && activeDraftDirty;
            return (
              <button
                key={definition.id}
                type="button"
                onClick={() => onSelect(definition.id)}
                {...(active ? { "aria-current": "true" as const } : {})}
                aria-label={`${definition.name} — ${metaLine(definition, unsaved)}`}
                title={`${definition.name} — ${metaLine(definition, unsaved)}`}
                className={cn(
                  "relative size-[28px] flex-shrink-0 cursor-pointer rounded-md border border-solid font-mono text-[0.74rem] font-semibold transition-all duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
                  active
                    ? cn(ROW_ACTIVE, "text-text-primary")
                    : "border-border-subtle bg-bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary",
                )}
              >
                <span aria-hidden="true">{initialOf(definition.name)}</span>
                {unsaved && (
                  <span className="absolute top-[-2px] right-[-2px]">
                    {unsavedDot}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <>
      {overlay && <RailOverlaySpacer side="left" stripWidth="48" />}
      <nav
        aria-label={title}
        className={cn(
          "flex w-[260px] min-w-[260px] flex-col overflow-hidden border-r border-solid border-border-subtle bg-bg-base max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-r-0 max-768:border-b max-768:border-solid max-768:border-b-border-dim max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow-builder][data-mobile-panel=inspector]_&]:hidden",
          overlay && railOverlayPanelClass("left"),
        )}
      >
        <div className="flex min-h-[44px] items-center gap-sm border-b border-solid border-border-dim px-[12px] py-[10px]">
          <h2 className="m-0 text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
            {title}
          </h2>
          {/* Below 768px the sidebar is not a rail but the Defs panel, and the
              bottom toolbar is what leaves it — collapsing is a no-op there, so
              the control is not offered rather than offered and inert. */}
          <button
            type="button"
            className={cn(WB_ICON_BTN, "ml-auto max-768:hidden")}
            onClick={() => setCollapsed(true)}
            aria-label={`Collapse ${title.toLowerCase()} sidebar`}
            title={`Collapse ${title.toLowerCase()} sidebar`}
          >
            <ChevronLeftIcon size={13} />
          </button>
        </div>

        <div className="border-b border-solid border-border-dim px-[12px] py-[10px]">
          <button
            className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT, "w-full")}
            onClick={onCreate}
            disabled={isCreating}
            aria-busy={isCreating || undefined}
            type="button"
          >
            <PlusIcon size={11} />
            {isCreating ? "Creating…" : "New workflow"}
          </button>
        </div>

        <div className="wb-sidebar-list flex flex-1 flex-col gap-[7px] overflow-y-auto px-[12px] py-[10px]">
          {isLoading ? (
            <div className="text-[0.72rem] text-text-tertiary">Loading...</div>
          ) : definitions.length === 0 ? (
            <div className="text-[0.72rem] text-text-tertiary">
              No workflows yet
            </div>
          ) : (
            <>
              {ordinaryDefinitions.map((definition) => {
                const active = definition.id === selectedId;
                const unsaved = active && activeDraftDirty;
                return (
                  <button
                    key={definition.id}
                    type="button"
                    onClick={() => onSelect(definition.id)}
                    {...(active ? { "aria-current": "true" as const } : {})}
                    className={cn(ROW_BASE, active ? ROW_ACTIVE : ROW_IDLE)}
                  >
                    <span className="flex w-full items-center gap-sm">
                      <span
                        className={cn(
                          "min-w-0 flex-1 overflow-hidden text-[0.76rem] font-semibold text-ellipsis whitespace-nowrap",
                          active ? "text-text-primary" : "text-text-secondary",
                        )}
                      >
                        {definition.name}
                      </span>
                      {unsaved && unsavedDot}
                    </span>
                    <span className="text-[0.7rem] font-normal text-text-tertiary">
                      {metaLine(definition, unsaved)}
                    </span>
                  </button>
                );
              })}
              {specDeliveryGroups.length > 0 && (
                <h3 className="mt-sm mb-0 text-[0.65rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                  Spec delivery
                </h3>
              )}
              {specDeliveryGroups.map((group) => {
                const selectedPast = group.past.some(
                  ({ id }) => id === selectedId,
                );
                const pastExpanded =
                  selectedPast || expandedPastSpecs.has(group.specId);
                const visible = pastExpanded
                  ? [...group.live, ...group.past]
                  : group.live;
                return (
                  <section
                    key={group.specId}
                    aria-label={`${group.specName} delivery candidates`}
                    className="flex flex-col gap-[7px]"
                  >
                    <h4 className="m-0 text-[0.72rem] font-semibold text-text-primary">
                      {group.specName}
                    </h4>
                    {visible.map((definition) => {
                      const active = definition.id === selectedId;
                      const unsaved =
                        active &&
                        activeDraftDirty &&
                        definition.management?.editable === true;
                      const meta = managedMetaLine(definition, unsaved);
                      return (
                        <button
                          key={definition.id}
                          type="button"
                          onClick={() => onSelect(definition.id)}
                          {...(active
                            ? { "aria-current": "true" as const }
                            : {})}
                          aria-label={`${definition.name} — ${meta}`}
                          className={cn(
                            ROW_BASE,
                            active ? ROW_ACTIVE : ROW_IDLE,
                          )}
                        >
                          <span className="flex w-full items-center gap-sm">
                            <span
                              className={cn(
                                "min-w-0 flex-1 overflow-hidden text-[0.76rem] font-semibold text-ellipsis whitespace-nowrap",
                                active
                                  ? "text-text-primary"
                                  : "text-text-secondary",
                              )}
                            >
                              {definition.name}
                            </span>
                            {unsaved && unsavedDot}
                          </span>
                          <span className="text-[0.7rem] font-normal text-text-tertiary">
                            {meta}
                          </span>
                        </button>
                      );
                    })}
                    {group.past.length > 0 && (
                      <button
                        type="button"
                        className="cursor-pointer border-0 bg-transparent px-xs py-[4px] text-left text-[0.7rem] font-medium text-text-tertiary hover:text-text-primary"
                        aria-expanded={pastExpanded}
                        onClick={() => {
                          setExpandedPastSpecs((current) => {
                            const next = new Set(current);
                            if (next.has(group.specId))
                              next.delete(group.specId);
                            else next.add(group.specId);
                            return next;
                          });
                        }}
                      >
                        Past candidates ({group.past.length})
                      </button>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
        {footer && (
          <div className="border-t border-solid border-border-dim px-md pt-sm pb-md">
            {footer}
          </div>
        )}
      </nav>
    </>
  );
}
