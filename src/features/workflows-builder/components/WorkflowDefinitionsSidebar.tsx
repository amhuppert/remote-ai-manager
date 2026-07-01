"use client";

import { cn } from "@/lib/ui/cn";

const WB_BTN_BASE =
  "inline-flex items-center justify-center gap-[6px] whitespace-nowrap cursor-pointer rounded-sm border border-solid border-border-default font-medium transition-all duration-150";
const WB_BTN_XS = "h-[22px] px-[8px] py-[3px] text-[0.7rem]";
const WB_BTN_DEFAULT =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:border-border-strong hover:text-text-primary";

const DOT_CLASS: Record<DotState["variant"], string> = {
  default: "bg-green shadow-[0_0_4px_var(--green-glow)]",
  workflow: "bg-cyan shadow-[0_0_4px_var(--cyan-glow)]",
  context: "bg-amber shadow-[0_0_4px_var(--amber-glow)]",
};

type ContextOverrideFields = {
  implementer?: unknown;
  contextValidator?: unknown;
  mutability?: unknown;
  circuitBreaker?: unknown;
  iterationPolicy?: unknown;
};

interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  revision: number;
  workflowConfig?: Record<string, unknown>;
  executionContexts?: ContextOverrideFields[];
}

interface WorkflowDefinitionsSidebarProps {
  definitions: WorkflowDefinitionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  isLoading: boolean;
  /** True while the create-definition mutation is in flight. */
  isCreating?: boolean;
  footer?: React.ReactNode;
  /** Heading shown above the list. Defaults to "Definitions". */
  title?: string;
}

type DotState =
  | { variant: "default"; tooltip: string }
  | { variant: "workflow"; tooltip: string }
  | { variant: "context"; tooltip: string };

const OVERRIDE_KEYS: Array<keyof ContextOverrideFields> = [
  "implementer",
  "contextValidator",
  "mutability",
  "circuitBreaker",
  "iterationPolicy",
];

function countContextOverrides(context: ContextOverrideFields): number {
  let count = 0;
  for (const key of OVERRIDE_KEYS) {
    if (context[key] !== undefined) count += 1;
  }
  return count;
}

function computeDotState(def: WorkflowDefinitionSummary): DotState {
  const contexts = def.executionContexts ?? [];
  let contextsWithOverrides = 0;
  let totalContextOverrides = 0;
  for (const ctx of contexts) {
    const n = countContextOverrides(ctx);
    if (n > 0) {
      contextsWithOverrides += 1;
      totalContextOverrides += n;
    }
  }

  if (contextsWithOverrides > 0) {
    return {
      variant: "context",
      tooltip: `Custom per-context config (${contextsWithOverrides} contexts, ${totalContextOverrides} overrides total)`,
    };
  }

  const workflowKeyCount = def.workflowConfig
    ? Object.keys(def.workflowConfig).length
    : 0;
  if (workflowKeyCount > 0) {
    return {
      variant: "workflow",
      tooltip: `Custom workflow defaults (${workflowKeyCount} blocks overridden)`,
    };
  }

  return { variant: "default", tooltip: "All defaults" };
}

export default function WorkflowDefinitionsSidebar({
  definitions,
  selectedId,
  onSelect,
  onCreate,
  isLoading,
  isCreating = false,
  footer,
  title = "Definitions",
}: WorkflowDefinitionsSidebarProps) {
  return (
    <aside className="flex w-[240px] min-w-[240px] flex-col overflow-hidden border-r border-solid border-border-subtle bg-bg-surface max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-r-0 max-768:border-b max-768:border-solid max-768:border-b-border-dim max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow-builder][data-mobile-panel=inspector]_&]:hidden">
      <div className="flex min-h-[44px] items-center justify-between border-b border-solid border-border-dim px-md py-[10px]">
        <span className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
          {title}
        </span>
        <button
          className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT)}
          onClick={onCreate}
          disabled={isCreating}
          aria-busy={isCreating || undefined}
          type="button"
          title="Create workflow"
        >
          {isCreating ? "Creating…" : "+"}
        </button>
      </div>

      <div className="wb-sidebar-list flex-1 overflow-y-auto py-xs">
        {isLoading ? (
          <div className="p-md text-[0.72rem] text-text-tertiary">
            Loading...
          </div>
        ) : definitions.length === 0 ? (
          <div className="p-md text-[0.72rem] text-text-tertiary">
            No workflows yet
          </div>
        ) : (
          definitions.map((def) => {
            const dot = computeDotState(def);
            const active = def.id === selectedId;
            return (
              <button
                key={def.id}
                className={cn(
                  "group flex w-full cursor-pointer appearance-none items-center gap-[10px] border-0 border-l-2 border-solid border-l-transparent bg-transparent px-md py-[10px] text-left font-[inherit] transition-all duration-150 hover:bg-bg-elevated",
                  active && "border-l-cyan bg-bg-raised",
                )}
                onClick={() => onSelect(def.id)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "overflow-hidden text-[0.78rem] font-medium text-ellipsis whitespace-nowrap text-text-secondary transition-colors duration-150 group-hover:text-text-primary",
                      active && "text-text-primary",
                    )}
                  >
                    {def.name}
                  </div>
                </div>
                <span className="flex-shrink-0 text-[0.7rem] font-normal text-text-tertiary">
                  r{def.revision}
                </span>
                <span
                  className={cn(
                    "mx-xs inline-block h-[6px] w-[6px] flex-shrink-0 rounded-full",
                    DOT_CLASS[dot.variant],
                  )}
                  data-tooltip={dot.tooltip}
                  aria-label={dot.tooltip}
                  role="img"
                />
              </button>
            );
          })
        )}
      </div>
      {footer && (
        <div className="border-t border-solid border-border-dim px-md pt-sm pb-md">
          {footer}
        </div>
      )}
    </aside>
  );
}
