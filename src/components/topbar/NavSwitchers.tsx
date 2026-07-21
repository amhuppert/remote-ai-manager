"use client";

// Breadcrumb switchers for the global top bar: the active-project and
// active-session breadcrumb items open searchable dropdowns (visual spec:
// claude.ai/design TopbarNav.dc.html). Radix Popover (via the CC primitive)
// owns positioning, dismissal, and focus; each panel owns the APG combobox
// wiring — DOM focus stays in the search input while ArrowUp/ArrowDown drive
// `aria-activedescendant` over the option rows.

import { Suspense, lazy, useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/ui/cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { StatusDot, type StatusDotTone } from "@/components/ui/StatusDot";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  useProjectsQuery,
  useProjectPreferencesQuery,
} from "@/lib/projects/queries";
import { useSessionsQuery } from "@/lib/sessions/queries";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { HOTKEY_REGISTRY, formatHotkeyDisplay } from "@/lib/shared/hotkeys";

// The create-session flow (Tiptap prompt editor and friends) is heavy and only
// needed after the user picks "New session", so it loads on demand rather than
// riding in every page's Topbar chunk.
const CreateSessionModal = lazy(
  () => import("@/features/project-detail/components/CreateSessionModal"),
);

const logger = createClientLogger("topbar-project-switcher");

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const triggerBase =
  "m-0 inline-flex cursor-pointer items-center gap-[5px] rounded-sm border-none bg-transparent px-[6px] py-[3px] font-mono text-[0.8rem] leading-none whitespace-nowrap transition-colors duration-[120ms] ease-[ease]";

const panelHeaderLabelClass =
  "font-mono text-[0.6rem] font-semibold tracking-[0.09em] text-text-tertiary uppercase";

const kbdChipClass =
  "ml-[8px] shrink-0 rounded-sm border border-solid border-border-default bg-bg-base px-[6px] py-px font-mono text-[0.62rem] text-text-secondary";

const searchInputClass =
  "box-border w-full rounded-sm border border-solid border-border-default bg-bg-base py-[6px] pr-[8px] pl-[27px] font-mono text-[0.78rem] text-text-primary outline-none placeholder:text-text-tertiary focus:border-cyan";

const groupLabelClass =
  "px-[8px] pb-[3px] font-mono text-[0.58rem] font-semibold tracking-[0.09em] text-text-tertiary uppercase";

const optionRowClass =
  "flex w-full cursor-pointer items-center gap-[9px] rounded-sm border-none bg-transparent px-[9px] py-[7px] text-left transition-[background] duration-100 ease-[ease] data-[active=true]:bg-bg-hover max-768:min-h-[44px]";

const optionNameClass =
  "min-w-0 flex-1 overflow-hidden font-mono text-[0.82rem] text-ellipsis whitespace-nowrap";

const emptyStateClass =
  "py-[14px] text-center font-mono text-[0.76rem] text-text-tertiary";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={cn(
        "opacity-70 transition-transform duration-150 ease-[ease]",
        open && "rotate-180",
      )}
    >
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="absolute top-1/2 left-[8px] -translate-y-1/2 text-text-tertiary"
    >
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.4 10.4 L13.5 13.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0 text-cyan"
    >
      <path
        d="M3 8.5 L6.2 11.5 L13 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface PanelHeaderProps {
  label: string;
  hotkeyId: "switchProject" | "switchSession";
}

function PanelHeader({ label, hotkeyId }: PanelHeaderProps) {
  return (
    <div className="mb-sm flex items-center justify-between">
      <span
        className={cn(
          panelHeaderLabelClass,
          "overflow-hidden text-ellipsis whitespace-nowrap",
        )}
      >
        {label}
      </span>
      <kbd className={kbdChipClass}>
        {formatHotkeyDisplay(HOTKEY_REGISTRY[hotkeyId].keys)}
      </kbd>
    </div>
  );
}

interface SwitcherSearchProps {
  value: string;
  onChange: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  listboxId: string;
  activeOptionId: string | undefined;
}

function SwitcherSearch({
  value,
  onChange,
  onKeyDown,
  placeholder,
  listboxId,
  activeOptionId,
}: SwitcherSearchProps) {
  return (
    <div className="relative mb-sm">
      <SearchIcon />
      <input
        type="text"
        role="combobox"
        aria-label={placeholder}
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the panel exists to
        // be typed into; focus lands here on open per the handoff spec.
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={searchInputClass}
      />
    </div>
  );
}

interface SwitcherOptionProps {
  id: string;
  /** Keyboard/hover highlight (aria-activedescendant target). */
  active: boolean;
  /** Whether this row is the currently-routed project/session. */
  current: boolean;
  onSelect: () => void;
  onHover: () => void;
  children: React.ReactNode;
}

function SwitcherOption({
  id,
  active,
  current,
  onSelect,
  onHover,
  children,
}: SwitcherOptionProps) {
  return (
    <div
      role="option"
      id={id}
      aria-selected={current}
      data-active={active}
      className={cn(optionRowClass, current && "bg-cyan-glow")}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      {children}
    </div>
  );
}

/**
 * Keyboard/hover active-index over a flat option list while DOM focus stays in
 * the search input. Returns the clamped index plus the input keydown handler.
 */
function useOptionNavigation(count: number, onCommit: (index: number) => void) {
  const [rawIndex, setRawIndex] = useState(0);
  const activeIndex = count === 0 ? -1 : Math.min(rawIndex, count - 1);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count > 0) setRawIndex(Math.min(activeIndex + 1, count - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count > 0) setRawIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) onCommit(activeIndex);
    }
  };

  return { activeIndex, setActiveIndex: setRawIndex, onKeyDown };
}

/** Scroll the active option into view as arrow keys move it. */
function useActiveOptionScroll(activeOptionId: string | undefined) {
  useEffect(() => {
    if (activeOptionId === undefined) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId]);
}

// ---------------------------------------------------------------------------
// Project switcher
// ---------------------------------------------------------------------------

interface ProjectSwitcherProps {
  /** Decoded project name shown in the breadcrumb (the active project). */
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * True while the sibling switcher is open. When this panel closes because
   * the other one is taking over (⌘P ⇄ ⌘J), Radix's focus return to this
   * trigger would steal focus from the new panel's search input — suppress it.
   */
  siblingOpen: boolean;
  /** Layout-only utilities from the breadcrumb row (mobile hide/truncate). */
  triggerLayoutClassName?: string;
  /** Route family to keep when the user changes project context. */
  destination?: "project" | "specs";
}

export function BreadcrumbProjectSwitcher({
  projectName,
  open,
  onOpenChange,
  siblingOpen,
  triggerLayoutClassName,
  destination = "project",
}: ProjectSwitcherProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch project"
          className={cn(
            triggerBase,
            open
              ? "bg-bg-hover text-text-primary"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
            triggerLayoutClassName,
          )}
        >
          <span className="min-w-0 overflow-hidden text-ellipsis">
            {projectName}
          </span>
          <Chevron open={open} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={7}
        layoutClassName="w-[268px]"
        // Swapping switchers (⌘P → ⌘J) closes this panel while its sibling
        // opens; the closing panel's focus return would land "outside" the new
        // panel and dismiss it. Outside *clicks* and Escape still close.
        onFocusOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (siblingOpen) event.preventDefault();
        }}
      >
        <ProjectSwitcherPanel
          activeProject={projectName}
          onDone={() => onOpenChange(false)}
          destination={destination}
        />
      </PopoverContent>
    </Popover>
  );
}

function ProjectSwitcherPanel({
  activeProject,
  onDone,
  destination,
}: {
  activeProject: string;
  onDone: () => void;
  destination: "project" | "specs";
}) {
  const router = useRouter();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const projectsQuery = useProjectsQuery();
  const prefsQuery = useProjectPreferencesQuery();

  // Preferences key projects by path; grouping/exclusion matches the projects
  // index (pinned on top, archived hidden), preserving the API's ordering
  // within each group like the index does.
  const { pinned, others } = useMemo(() => {
    const projects = projectsQuery.data ?? [];
    const pinnedSet = new Set(prefsQuery.data?.pinned ?? []);
    const archivedSet = new Set(prefsQuery.data?.archived ?? []);
    const q = query.trim().toLowerCase();
    const visible = projects.filter(
      (p) =>
        !archivedSet.has(p.path) &&
        (q === "" || p.name.toLowerCase().includes(q)),
    );
    return {
      pinned: visible.filter((p) => pinnedSet.has(p.path)),
      others: visible.filter((p) => !pinnedSet.has(p.path)),
    };
  }, [projectsQuery.data, prefsQuery.data, query]);

  const flat = useMemo(() => [...pinned, ...others], [pinned, others]);

  const selectProject = (name: string) => {
    onDone();
    const href =
      destination === "specs"
        ? `/specs?project=${encodeURIComponent(name)}`
        : `/projects/${encodeURIComponent(name)}`;
    logger.info("topbar.project_switcher.selected", {
      activeProject,
      destination,
      projectName: name,
    });
    router.push(href);
  };

  const { activeIndex, setActiveIndex, onKeyDown } = useOptionNavigation(
    flat.length,
    (index) => {
      const target = flat[index];
      if (target !== undefined) selectProject(target.name);
    },
  );
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const activeOptionId = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  useActiveOptionScroll(activeOptionId);

  const isLoading = projectsQuery.isPending || prefsQuery.isPending;

  const renderOption = (
    project: (typeof flat)[number],
    index: number,
  ): React.ReactNode => {
    const current = project.name === activeProject;
    return (
      <SwitcherOption
        key={project.path}
        id={optionId(index)}
        active={index === activeIndex}
        current={current}
        onSelect={() => selectProject(project.name)}
        onHover={() => setActiveIndex(index)}
      >
        {project.hasRunningSession ? (
          <StatusDot tone="cyan" layoutClassName="shrink-0" />
        ) : (
          <span aria-hidden="true" className="size-[7px] shrink-0" />
        )}
        <span
          className={cn(
            optionNameClass,
            current
              ? "font-semibold text-cyan"
              : "font-medium text-text-primary",
          )}
        >
          {project.name}
        </span>
        {current && <CheckIcon />}
      </SwitcherOption>
    );
  };

  return (
    <div>
      <PanelHeader label="Switch project" hotkeyId="switchProject" />
      <SwitcherSearch
        value={query}
        onChange={setQuery}
        onKeyDown={onKeyDown}
        placeholder="Search projects…"
        listboxId={listboxId}
        activeOptionId={activeOptionId}
      />
      {isLoading ? (
        <div role="status" className={emptyStateClass}>
          Loading projects…
        </div>
      ) : flat.length === 0 ? (
        <div role="status" className={emptyStateClass}>
          No projects match
        </div>
      ) : (
        <div role="listbox" id={listboxId} aria-label="Projects">
          {pinned.length > 0 && (
            <div role="group" aria-label="Pinned">
              <div
                aria-hidden="true"
                className={cn(groupLabelClass, "pt-[4px]")}
              >
                Pinned
              </div>
              <div className="flex flex-col gap-px">
                {pinned.map((p, i) => renderOption(p, i))}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div role="group" aria-label="All projects">
              {pinned.length > 0 && (
                <div
                  aria-hidden="true"
                  className={cn(groupLabelClass, "pt-[8px]")}
                >
                  All projects
                </div>
              )}
              <div className="flex max-h-[230px] flex-col gap-px overflow-y-auto">
                {others.map((p, i) => renderOption(p, pinned.length + i))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session switcher
// ---------------------------------------------------------------------------

type SessionRowStatus = SessionListItem["derivedStatus"] | "merged";

const glowTone: Partial<Record<SessionRowStatus, StatusDotTone>> = {
  new: "cyan",
  running: "cyan",
  awaiting: "green",
  waiting_for_input: "amber",
};

/** Dot colors mirror SessionRow's rail: glowing for live states, dimmed static for idle/merged. */
function SessionDot({ session }: { session: SessionListItem }) {
  const status: SessionRowStatus = session.finished
    ? "merged"
    : session.derivedStatus;
  const tone = glowTone[status];
  if (tone !== undefined) {
    return <StatusDot tone={tone} layoutClassName="shrink-0" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        status === "merged"
          ? "bg-green opacity-[0.55]"
          : "bg-text-tertiary opacity-50",
      )}
    />
  );
}

interface SessionSwitcherProps {
  projectName: string;
  /** Decoded session name shown in the breadcrumb (the active session). */
  sessionName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** See {@link ProjectSwitcherProps.siblingOpen}. */
  siblingOpen: boolean;
  triggerLayoutClassName?: string;
}

export function BreadcrumbSessionSwitcher({
  projectName,
  sessionName,
  open,
  onOpenChange,
  siblingOpen,
  triggerLayoutClassName,
}: SessionSwitcherProps) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Switch session"
            className={cn(
              triggerBase,
              "font-semibold text-text-primary",
              open ? "bg-bg-hover" : "hover:bg-bg-hover",
              triggerLayoutClassName,
            )}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis">
              {sessionName}
            </span>
            <Chevron open={open} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={7}
          layoutClassName="w-[288px]"
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            if (siblingOpen) event.preventDefault();
          }}
        >
          <SessionSwitcherPanel
            projectName={projectName}
            activeSession={sessionName}
            onDone={() => onOpenChange(false)}
            onNewSession={() => {
              onOpenChange(false);
              setCreateOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>
      {createOpen && (
        <Suspense fallback={null}>
          <CreateSessionModal
            projectName={projectName}
            open
            onClose={() => setCreateOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

function SessionSwitcherPanel({
  projectName,
  activeSession,
  onDone,
  onNewSession,
}: {
  projectName: string;
  activeSession: string;
  onDone: () => void;
  onNewSession: () => void;
}) {
  const router = useRouter();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const sessionsQuery = useSessionsQuery(projectName);

  const sessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sessionsQuery.data ?? [])
      .filter(
        (s) =>
          !s.archived && (q === "" || s.sessionName.toLowerCase().includes(q)),
      )
      .sort((a, b) =>
        b.derivedLastActivityAt.localeCompare(a.derivedLastActivityAt),
      );
  }, [sessionsQuery.data, query]);

  const selectSession = (name: string) => {
    onDone();
    router.push(
      `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(name)}`,
    );
  };

  const { activeIndex, setActiveIndex, onKeyDown } = useOptionNavigation(
    sessions.length,
    (index) => {
      const target = sessions[index];
      if (target !== undefined) selectSession(target.sessionName);
    },
  );
  const optionId = (index: number) => `${listboxId}-option-${index}`;
  const activeOptionId = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  useActiveOptionScroll(activeOptionId);

  return (
    <div>
      <PanelHeader
        label={`Sessions · ${projectName}`}
        hotkeyId="switchSession"
      />
      <SwitcherSearch
        value={query}
        onChange={setQuery}
        onKeyDown={onKeyDown}
        placeholder="Search sessions…"
        listboxId={listboxId}
        activeOptionId={activeOptionId}
      />
      {sessionsQuery.isPending ? (
        <div role="status" className={emptyStateClass}>
          Loading sessions…
        </div>
      ) : sessions.length === 0 ? (
        <div role="status" className={emptyStateClass}>
          No sessions match
        </div>
      ) : (
        <div
          role="listbox"
          id={listboxId}
          aria-label={`Sessions in ${projectName}`}
          className="flex max-h-[280px] flex-col gap-px overflow-y-auto"
        >
          {sessions.map((session, index) => {
            const current = session.sessionName === activeSession;
            return (
              <SwitcherOption
                key={session.sessionName}
                id={optionId(index)}
                active={index === activeIndex}
                current={current}
                onSelect={() => selectSession(session.sessionName)}
                onHover={() => setActiveIndex(index)}
              >
                <SessionDot session={session} />
                <span
                  className={cn(
                    optionNameClass,
                    current
                      ? "font-semibold text-cyan"
                      : "font-medium text-text-primary",
                  )}
                >
                  {session.sessionName}
                </span>
                <span className="shrink-0 font-mono text-[0.68rem] text-text-tertiary">
                  {formatRelativeTime(session.derivedLastActivityAt, {
                    style: "short",
                  })}
                </span>
                {current && <CheckIcon />}
              </SwitcherOption>
            );
          })}
        </div>
      )}
      <div className="mt-[6px] border-x-0 border-t border-b-0 border-solid border-border-subtle pt-[6px]">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full cursor-pointer items-center gap-[8px] rounded-sm border border-solid border-border-default bg-transparent px-[9px] py-[7px] text-left font-mono text-[0.78rem] text-cyan transition-[background,border-color] duration-[120ms] ease-[ease] hover:border-cyan hover:bg-cyan-glow max-768:min-h-[44px]"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 3 V13 M3 8 H13"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          New session
        </button>
      </div>
    </div>
  );
}
