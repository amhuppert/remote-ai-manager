"use client";

import Topbar from "@/components/Topbar";
import TddToggle from "@/components/TddToggle";
import LayoutSwitcher from "@/features/session/conversation/LayoutSwitcher";
import DevServerDrawer from "@/components/DevServerDrawer";
import { CloseIcon } from "@/components/icons";
import type { ComponentProps } from "react";

type LayoutSwitcherProps = ComponentProps<typeof LayoutSwitcher>;
type DevServerDrawerProps = ComponentProps<typeof DevServerDrawer>;

export interface SessionTopbarProps {
  projectName: string;
  sessionName: string;
  decodedProjectName: string;
  statusDotClass: string;
  displayStatus: string;
  tddEnabled: boolean;
  onTddChange: (value: boolean) => void;
  tddDisabled: boolean;
  layout: LayoutSwitcherProps["activeLayout"];
  onLayoutChange: LayoutSwitcherProps["onLayoutChange"];
  dsOpen: boolean;
  dsServers: DevServerDrawerProps["servers"];
  dsClose: () => void;
  dsToggle: () => void;
  dsStartServer: DevServerDrawerProps["onStart"];
  dsStopServer: DevServerDrawerProps["onStop"];
  dsStartAll: () => void;
  dsStopAll: () => void;
  commitDisabled: boolean;
  mergeDisabled: boolean;
  targetBranch: string;
  onCommit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}

export default function SessionTopbar({
  projectName,
  sessionName,
  decodedProjectName,
  statusDotClass,
  displayStatus,
  tddEnabled,
  onTddChange,
  tddDisabled,
  layout,
  onLayoutChange,
  dsOpen,
  dsServers,
  dsClose,
  dsToggle,
  dsStartServer,
  dsStopServer,
  dsStartAll,
  dsStopAll,
  commitDisabled,
  mergeDisabled,
  targetBranch,
  onCommit,
  onMerge,
  onDelete,
}: SessionTopbarProps): React.JSX.Element {
  return (
    <Topbar
      page="detail"
      breadcrumbs={[
        { label: "projects", href: "/projects" },
        {
          label: decodedProjectName,
          href: `/projects/${encodeURIComponent(projectName)}`,
        },
        {
          label: sessionName,
          href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
          isSession: true,
        },
      ]}
      sessionControls={
        <>
          <div className="status-indicator">
            <div className={`status-dot ${statusDotClass}`} />
            {displayStatus}
          </div>
          <div className="topbar-sep" />
          <TddToggle
            enabled={tddEnabled}
            onChange={onTddChange}
            disabled={tddDisabled}
            compact
          />
          <div className="topbar-sep" />
          <LayoutSwitcher
            activeLayout={layout}
            onLayoutChange={onLayoutChange}
          />
          <DevServerDrawer
            open={dsOpen}
            servers={dsServers}
            onClose={dsClose}
            onToggle={dsToggle}
            onStart={dsStartServer}
            onStop={dsStopServer}
            onStartAll={dsStartAll}
            onStopAll={dsStopAll}
          />
          <div className="topbar-sep" />
          <button
            className="btn btn-sm"
            data-tooltip="Commit changes"
            disabled={commitDisabled}
            onClick={onCommit}
          >
            Commit
          </button>
          <button
            className="btn btn-sm btn-primary"
            data-tooltip={`Merge into ${targetBranch}`}
            disabled={mergeDisabled}
            onClick={onMerge}
          >
            Merge
          </button>
          <div className="topbar-sep" />
          <button
            className="btn-icon-only danger"
            data-tooltip="Delete session"
            aria-label="Delete session"
            onClick={onDelete}
          >
            <CloseIcon />
          </button>
        </>
      }
    />
  );
}
