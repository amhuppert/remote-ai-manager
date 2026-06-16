"use client";

import Link from "next/link";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import { Badge, type BadgeStatus } from "@/components/ui/Badge";
import CardContextMenu, {
  type ContextMenuItem,
} from "@/components/CardContextMenu";

interface ProjectCardProps {
  project: DiscoveredProject;
  archived: boolean;
  pinned: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: (projectPath: string) => void;
  onPin: (projectPath: string) => void;
  onDelete: (project: DiscoveredProject) => void;
}

type CardActivity = "active" | "has-sessions" | "idle";

// Invariant box: layout, border (1px solid subtle), radius, padding, transition,
// and the base hover lift/shadow shared by every activity tier. Appearance that
// varies by activity/pinned/archived state lives in the data-* blocks below so no
// two applied utilities target the same property by source order (overrides win on
// attribute/`:hover` specificity instead).
const CARD_BASE =
  "group relative cursor-pointer overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl " +
  "transition-all duration-200 ease-[ease] [content-visibility:auto] [contain-intrinsic-size:0_180px] " +
  "hover:-translate-y-px hover:border-border-strong hover:bg-bg-raised hover:shadow-[0_4px_16px_-4px_var(--cc-shadow-soft)]";

// The top edge gradient (cyan, fades in on hover). Pinned recolors it amber and
// shows it at 0.5 opacity even at rest.
const CARD_BEFORE =
  "before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-[linear-gradient(90deg,transparent,var(--cyan-dim),transparent)] before:opacity-0 before:transition-opacity before:duration-200 before:ease-[ease] before:content-[''] " +
  "hover:before:opacity-100 " +
  "data-[pinned=true]:before:bg-[linear-gradient(90deg,transparent,var(--amber-dim),transparent)] data-[pinned=true]:before:opacity-50 data-[pinned=true]:hover:before:opacity-100";

// Activity tiers: idle recesses (darker bg, dim border, brightens on hover);
// has-sessions sits on the surface (default border); active elevates with a cyan
// left edge and cyan glow that intensifies on hover.
const CARD_ACTIVITY =
  "data-[activity=idle]:border-border-dim data-[activity=idle]:bg-bg-base data-[activity=idle]:hover:border-border-subtle data-[activity=idle]:hover:bg-bg-surface " +
  "data-[activity=has-sessions]:border-border-default data-[activity=has-sessions]:hover:border-border-strong " +
  "data-[activity=active]:border-l-[3px] data-[activity=active]:border-l-cyan data-[activity=active]:bg-bg-raised " +
  "data-[activity=active]:shadow-[inset_3px_0_8px_-4px_var(--cyan-glow),0_0_16px_-4px_var(--cc-cyan-a12)] " +
  "data-[activity=active]:hover:shadow-[inset_3px_0_12px_-4px_var(--cc-cyan-a25),0_0_24px_-4px_var(--cc-cyan-a18)]";

// Legacy quirk preserved: the pinned amber border only renders when the card is
// also active — for has-sessions/idle the activity border rule (later in the
// source) wins. Apply amber to top/right/bottom only so the active cyan left edge
// survives.
const CARD_PINNED_ACTIVE =
  "data-[activity=active]:data-[pinned=true]:border-t-[var(--cc-amber-border)] data-[activity=active]:data-[pinned=true]:border-r-[var(--cc-amber-border)] data-[activity=active]:data-[pinned=true]:border-b-[var(--cc-amber-border)] " +
  "data-[activity=active]:data-[pinned=true]:hover:border-t-[var(--cc-amber-border-strong)] data-[activity=active]:data-[pinned=true]:hover:border-r-[var(--cc-amber-border-strong)] data-[activity=active]:data-[pinned=true]:hover:border-b-[var(--cc-amber-border-strong)]";

const CARD_ARCHIVED =
  "data-[archived=true]:border-dashed data-[archived=true]:opacity-[0.55] data-[archived=true]:hover:opacity-[0.75]";

const CARD_CLASS = `${CARD_BASE} ${CARD_BEFORE} ${CARD_ACTIVITY} ${CARD_PINNED_ACTIVE} ${CARD_ARCHIVED}`;

// Name dims to secondary only for an at-rest idle card, brightening back to
// primary when that idle card is hovered (legacy `.idle .project-name` /
// `.idle:hover .project-name`).
const NAME_CLASS =
  "font-mono text-[1.05rem] font-semibold tracking-[-0.01em] text-text-primary " +
  "group-data-[activity=idle]:text-text-secondary " +
  "[.group[data-activity=idle]:hover_&]:text-text-primary";

// 24px ghost button; star colour/glow keys off hover and the pinned state. Color
// and filter live on the button so the (classless) star inherits them. Mobile
// enforces the 44px touch-target minimum.
const PIN_BTN_CLASS =
  "flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-[0.9rem] leading-none text-text-tertiary " +
  "transition-all duration-150 ease-[ease] " +
  "hover:text-amber hover:[filter:drop-shadow(0_0_3px_var(--cc-amber-a40))] " +
  "data-[pinned=true]:text-amber data-[pinned=true]:[filter:drop-shadow(0_0_4px_var(--cc-amber-a50))] " +
  "data-[pinned=true]:hover:text-amber-dim data-[pinned=true]:hover:[filter:drop-shadow(0_0_6px_var(--cc-amber-a60))] " +
  "max-768:min-h-[44px] max-768:min-w-[44px]";

const STAT_VALUE_CLASS = "font-mono text-[1.2rem] font-bold text-text-primary";
const STAT_LABEL_CLASS =
  "font-mono text-[0.7rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

export default function ProjectCard({
  project,
  archived,
  pinned,
  menuOpen,
  onMenuToggle,
  onArchive,
  onPin,
  onDelete,
}: ProjectCardProps): React.JSX.Element {
  const missing = project.missing === true;
  const activity: CardActivity = project.hasRunningSession
    ? "active"
    : project.activeSessions > 0
      ? "has-sessions"
      : "idle";
  const badgeStatus: BadgeStatus = project.hasRunningSession
    ? "running"
    : project.activeSessions > 0
      ? "active"
      : "idle";
  const badgeText = project.hasRunningSession
    ? "running"
    : project.activeSessions > 0
      ? `${project.activeSessions} session${project.activeSessions === 1 ? "" : "s"}`
      : "idle";

  const menuItems: ContextMenuItem[] = [];
  if (!missing) {
    menuItems.push({
      label: pinned ? "Unpin Project" : "Pin Project",
      onAction: () => onPin(project.path),
    });
    menuItems.push({
      label: archived ? "Unarchive Project" : "Archive Project",
      onAction: () => onArchive(project.path),
    });
  }
  menuItems.push({
    label: "Delete Project",
    danger: true,
    onAction: () => onDelete(project),
  });

  const body = (
    <>
      <div className="mb-md flex items-start justify-between">
        <div className={NAME_CLASS}>{project.name}</div>
        <div className="flex items-center gap-[8px]">
          {!missing && (
            <button
              className={PIN_BTN_CLASS}
              data-pinned={pinned}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onPin(project.path);
              }}
              title={pinned ? "Unpin project" : "Pin project"}
              type="button"
            >
              <span>{pinned ? "★" : "☆"}</span>
            </button>
          )}
          {missing ? (
            <Badge status="idle">missing</Badge>
          ) : archived ? (
            <Badge status="idle">archived</Badge>
          ) : (
            <Badge status={badgeStatus}>{badgeText}</Badge>
          )}
          <CardContextMenu
            items={menuItems}
            open={menuOpen}
            onToggle={onMenuToggle}
          />
        </div>
      </div>
      <div className="mb-lg overflow-hidden font-mono text-[0.72rem] text-ellipsis whitespace-nowrap text-text-tertiary">
        {project.path}
      </div>
      <div className="flex gap-lg border-x-0 border-t border-b-0 border-solid border-border-subtle pt-md">
        <div className="flex flex-col gap-[2px]">
          <span className={STAT_VALUE_CLASS}>{project.activeSessions}</span>
          <span className={STAT_LABEL_CLASS}>Sessions</span>
        </div>
        <div className="flex flex-col gap-[2px]">
          <span className={STAT_VALUE_CLASS}>0</span>
          <span className={STAT_LABEL_CLASS}>Prompts</span>
        </div>
        <div className="flex flex-col gap-[2px]">
          <span className="font-mono text-[1.2rem] font-bold text-text-tertiary not-italic">
            &mdash;
          </span>
          <span className={STAT_LABEL_CLASS}>Last active</span>
        </div>
      </div>
    </>
  );

  if (missing) {
    return (
      <div
        className={CARD_CLASS}
        data-activity={activity}
        data-pinned={pinned}
        data-archived={archived}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className={CARD_CLASS}
      data-activity={activity}
      data-pinned={pinned}
      data-archived={archived}
    >
      {body}
    </Link>
  );
}
