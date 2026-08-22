"use client";

import {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { StatusChip } from "@/components/ui/StatusChip";
import { useMediaQueryMatch } from "@/hooks/use-media-query";
import { cn } from "@/lib/ui/cn";
import { configAffordanceBanner, configSaveBar } from "./affordance";
import {
  ConfigAffordanceBanner,
  ConfigSaveAlert,
  ConfigSaveBar,
} from "./AffordanceChrome";
import { ConfigDangerButton } from "./ConfigControls";
import { ConfigRootCardList, type ConfigRootCard } from "./ConfigRootCardList";
import { ChevronLeftIcon } from "./icons";
import {
  createPanelNavigationState,
  currentEntry,
  isRootScreen,
  panelNavigationReducer,
  parentScreenId,
  ROOT_SCREEN_ID,
} from "./panel-navigation";
import { useMobilePanelOnScreen } from "@/components/workflow-graph/mobile-panel-visibility";
import { usePanelBackGesture } from "./usePanelBackGesture";
import type {
  ConfigScreenRegistry,
  ResolvedConfigScreen,
} from "./screen-registry";
import type {
  ConfigAffordance,
  ConfigPanelHost,
  ConfigReadOnlyReason,
  ConfigSaveState,
  ConfigScope,
} from "./types";

export interface ConfigPanelProps {
  host: ConfigPanelHost;
  /** The tier being edited. The execution host is always `context`. */
  scope: ConfigScope;
  onScopeChange?: (scope: ConfigScope) => void;
  /** Root header: the context title, or the workflow name. */
  entityTitle: string;
  entityMeta: string;
  /** Tier-wide override count, e.g. `2 blocks · 1 role set here`. */
  overrideSummary?: string;
  hasOverrides?: boolean;
  rootCards: readonly ConfigRootCard[];
  screens: ConfigScreenRegistry;
  /** What the run's state permits right now. Execution host only. */
  affordance?: ConfigAffordance;
  readOnlyReason?: ConfigReadOnlyReason;
  onPauseToEdit?: () => void;
  /** The pause is in flight, so the banner action reads `Pausing…`. */
  pausing?: boolean;
  saveState?: ConfigSaveState;
  /**
   * Why the save is refused before submission, in the refusing module's own
   * words — `outputSchemaSaveBlockReason` for the contract text,
   * `livePlacementIssue` for the placement, or the host's own account of a
   * submission it cannot make yet. Null when nothing blocks.
   */
  saveBlockedReason?: string | null;
  /** The server's own refusal, shown when `saveState` is `error`. */
  saveErrorMessage?: string;
  onSave?: () => void;
  onResume?: () => void;
  /**
   * The execution can actually be resumed (paused or halted). Without it the
   * saved state would offer a resume for a run that never stopped.
   */
  resumable?: boolean;
  /** The resume is in flight, so the save bar's resume reads `Resuming…`. */
  resuming?: boolean;
  /**
   * A dictation is settling into a prose editor, so Save stays reachable — it
   * is the stop-and-submit control — unless `saveBlockedReason` says the
   * submission cannot happen.
   */
  voiceBusy?: boolean;
  onResetAll?: () => void;
  /**
   * The destructive action the tier offers, shown in the execution host's
   * footer (README §11 lands context reset here). The panel renders the trigger
   * only — the confirmation is the host's, because the host owns both the copy
   * and the mutation the confirmation authorizes.
   */
  dangerAction?: {
    label: string;
    onAction: () => void;
    disabled?: boolean;
  };
  /** Opens the panel already drilled in, for a deep link or a story. */
  initialScreenPath?: readonly string[];
}

/**
 * The parent a back row names when the reader is one level down. The root
 * screen has no registered title of its own: on the builder it is the tier
 * being edited, and on the execution host it is the context's Config tab.
 */
function rootBackLabel(host: ConfigPanelHost, scope: ConfigScope): string {
  if (host === "execution") return "Config";
  return scope === "context" ? "Context" : "Workflow";
}

/**
 * A registered screen renders as its own component so its body is a child
 * element rather than a function call inside the panel's own render.
 */
function ConfigScreenBody({
  screen,
  scope,
  navigate,
  back,
}: {
  screen: ResolvedConfigScreen;
  scope: ConfigScope;
  navigate: (screenId: string) => void;
  back: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[10px] px-lg py-md">
      {screen.definition.render({
        screenId: screen.screenId,
        param: screen.param,
        scope,
        navigate,
        back,
      })}
    </div>
  );
}

function activeElementId(): string | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.id !== "" ? active.id : null;
}

export function ConfigPanel({
  host,
  scope,
  onScopeChange,
  entityTitle,
  entityMeta,
  overrideSummary,
  hasOverrides = false,
  rootCards,
  screens,
  affordance = "editable",
  readOnlyReason,
  onPauseToEdit,
  pausing = false,
  saveState = "clean",
  saveBlockedReason = null,
  saveErrorMessage,
  onSave,
  onResume,
  resumable = false,
  resuming = false,
  voiceBusy = false,
  onResetAll,
  dangerAction,
  initialScreenPath,
}: ConfigPanelProps): React.JSX.Element {
  const [navigation, dispatch] = useReducer(
    panelNavigationReducer,
    initialScreenPath ?? [],
    createPanelNavigationState,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set by a back step so the layout effect knows this render is a RETURN to a
  // remembered screen rather than a fresh push.
  const restoring = useRef(false);

  // A scope switch is a different tier's configuration, so the stack it was
  // built against no longer exists.
  const [renderedScope, setRenderedScope] = useState(scope);
  if (renderedScope !== scope) {
    setRenderedScope(scope);
    dispatch({ type: "reset" });
  }

  const entry = currentEntry(navigation);
  const atRoot = isRootScreen(navigation);
  const parentId = parentScreenId(navigation);

  const navigate = useCallback((screenId: string) => {
    dispatch({
      type: "push",
      screenId,
      scrollTop: bodyRef.current?.scrollTop ?? 0,
      returnFocusId: activeElementId(),
    });
  }, []);

  const back = useCallback(() => {
    restoring.current = true;
    dispatch({ type: "back" });
  }, []);

  // §12: below the breakpoint a drill level fills the screen, so the system
  // back gesture unwinds it the way the back row does. Above it the drill is a
  // rail and the back button stays the app's. The bottom toolbar leaves the
  // panel mounted when it switches away, so an off-screen panel gives the
  // gesture back rather than spending it on a stack nobody can see.
  const isMobileViewport = useMediaQueryMatch("(max-width: 768px)");
  const onScreen = useMobilePanelOnScreen();
  usePanelBackGesture({
    enabled: isMobileViewport && onScreen,
    depth: navigation.stack.length - 1,
    onBack: back,
  });

  useLayoutEffect(() => {
    if (!restoring.current) {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      return;
    }
    restoring.current = false;
    if (bodyRef.current) bodyRef.current.scrollTop = entry.scrollTop;
    if (entry.returnFocusId !== null) {
      document.getElementById(entry.returnFocusId)?.focus();
    }
  }, [entry]);

  const screen =
    entry.screenId === ROOT_SCREEN_ID
      ? undefined
      : screens.resolve(entry.screenId);

  const backLabel =
    parentId === null || parentId === ROOT_SCREEN_ID
      ? rootBackLabel(host, scope)
      : (screens.titleOf(parentId) ?? parentId);

  const banner = configAffordanceBanner({ host, affordance, readOnlyReason });
  const saveBar = configSaveBar({
    host,
    affordance,
    saveState,
    blockedReason: saveBlockedReason,
    errorMessage: saveErrorMessage,
    resumable,
    voiceBusy,
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-surface font-mono">
      {host === "builder" ? (
        <div className="flex flex-shrink-0 items-center gap-[10px] border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[9px]">
          <SegmentedControl
            value={scope}
            onValueChange={(next) => {
              if (next === "workflow" || next === "context") {
                onScopeChange?.(next);
              }
            }}
            aria-label="Inspector scope"
          >
            <SegmentedControlItem value="workflow">
              Workflow
            </SegmentedControlItem>
            <SegmentedControlItem value="context">Context</SegmentedControlItem>
          </SegmentedControl>
          {overrideSummary ? (
            <span
              data-testid="config-override-summary"
              className={cn(
                "ml-auto font-mono text-[0.7rem] font-medium",
                hasOverrides ? "text-cyan" : "text-text-tertiary",
              )}
            >
              {overrideSummary}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="box-border flex min-h-[44px] flex-shrink-0 items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[10px]">
        {atRoot ? (
          <div className="flex min-w-0 flex-col gap-[3px]">
            <span className="truncate font-mono text-[0.82rem] font-semibold text-text-primary">
              {entityTitle}
            </span>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {entityMeta}
            </span>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={back}
              aria-label={`Back to ${backLabel}`}
              className="inline-flex h-[24px] flex-shrink-0 cursor-pointer items-center gap-[6px] rounded-sm border border-solid border-border-default bg-bg-raised px-sm font-mono text-[0.72rem] font-medium text-text-secondary hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:h-auto max-768:min-h-[44px]"
            >
              <ChevronLeftIcon size={12} />
              {backLabel}
            </button>
            <span
              data-testid="config-screen-title"
              className="min-w-0 truncate font-mono text-[0.74rem] font-semibold tracking-[0.07em] text-text-primary uppercase"
            >
              {screen?.title ?? entry.screenId}
            </span>
          </>
        )}
        {screen?.overrideLabel ? (
          <StatusChip
            tone="cyan"
            data-testid="config-screen-badge"
            layoutClassName="ml-auto shrink-0"
          >
            {screen.overrideLabel}
          </StatusChip>
        ) : null}
      </div>

      {banner ? (
        <ConfigAffordanceBanner
          banner={banner}
          onAction={onPauseToEdit}
          pending={pausing}
          pendingLabel="Pausing…"
        />
      ) : null}

      {saveBar?.alertText ? <ConfigSaveAlert text={saveBar.alertText} /> : null}

      <div
        ref={bodyRef}
        data-testid="config-panel-body"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {atRoot ? (
          <ConfigRootCardList cards={rootCards} onOpen={navigate} />
        ) : screen ? (
          <ConfigScreenBody
            screen={screen}
            scope={scope}
            navigate={navigate}
            back={back}
          />
        ) : null}
      </div>

      {saveBar ? (
        <ConfigSaveBar
          saveBar={saveBar}
          onSave={onSave}
          onResume={onResume}
          resuming={resuming}
        />
      ) : null}

      {host === "execution" && dangerAction ? (
        <div
          data-testid="config-danger-footer"
          className="flex flex-shrink-0 items-center border-x-0 border-t border-b-0 border-solid border-border-dim px-lg py-sm"
        >
          <ConfigDangerButton
            label={dangerAction.label}
            onClick={dangerAction.onAction}
            disabled={dangerAction.disabled ?? false}
          />
        </div>
      ) : null}

      {host === "builder" ? (
        <div className="flex flex-shrink-0 items-center gap-md border-x-0 border-t border-b-0 border-solid border-border-dim px-lg py-sm font-mono text-[0.7rem] text-text-tertiary">
          <span className="inline-flex items-center gap-[5px]">
            <span
              aria-hidden="true"
              className="size-[5px] rounded-full bg-cyan"
            />
            set here
          </span>
          <span>W workflow</span>
          <span>G global</span>
          <button
            type="button"
            onClick={onResetAll}
            className="ml-auto inline-flex h-[22px] cursor-pointer items-center rounded-sm border-0 bg-transparent px-sm font-mono text-[0.7rem] font-medium text-cyan hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:h-auto max-768:min-h-[44px]"
          >
            Reset all overrides
          </button>
        </div>
      ) : null}
    </div>
  );
}
