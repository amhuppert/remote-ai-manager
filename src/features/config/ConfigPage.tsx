"use client";

import "./styles/config-editor.css";
import { useState } from "react";
import Topbar from "@/components/Topbar";
import { useFullConfigQuery } from "@/lib/config/queries";
import { useUpdateConfigMutation } from "@/lib/config/mutations";
import { ConfigSaveBar } from "./components/ConfigSaveBar";
import { SEEDED_WORKFLOW_DEFAULTS } from "./form-state";
import { BackendsSection } from "./sections/BackendsSection";
import { CapabilitiesSection } from "./sections/CapabilitiesSection";
import { DefaultsSection } from "./sections/DefaultsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { LimitsSection } from "./sections/LimitsSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { WorkflowSection } from "./sections/WorkflowSection";
import { useConfigForm } from "./use-config-form";

export { SEEDED_WORKFLOW_DEFAULTS };

type ConfigNavSection =
  | "general"
  | "defaults"
  | "capabilities"
  | "backends"
  | "workflow"
  | "limits"
  | "notifications";

const CONFIG_NAV: Array<{ id: ConfigNavSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "defaults", label: "Agent defaults" },
  { id: "capabilities", label: "Capabilities" },
  { id: "backends", label: "Backends" },
  { id: "workflow", label: "Workflow defaults" },
  { id: "limits", label: "Limits & timeouts" },
  { id: "notifications", label: "Notifications" },
];

export default function ConfigPage(): React.JSX.Element {
  const configQuery = useFullConfigQuery();
  const mutation = useUpdateConfigMutation();
  const { controller, dirtyCount, buildSavePayload, applySaved, revert } =
    useConfigForm(configQuery.data);
  const [activeSection, setActiveSection] =
    useState<ConfigNavSection>("general");

  if (configQuery.isPending) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">Loading configuration...</div>
          </div>
        </main>
      </div>
    );
  }

  if (configQuery.isError || !controller) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">
              Failed to load configuration
            </div>
            <div className="empty-state-desc">
              {configQuery.error?.message ?? "Unknown error"}
            </div>
          </div>
        </main>
      </div>
    );
  }

  const handleSave = () => {
    const payload = buildSavePayload();
    if (!payload) return;
    mutation.mutate(payload, {
      onSuccess: (data) => applySaved(data),
    });
  };

  const contentIsCapabilities = activeSection === "capabilities";

  return (
    <div className="app" data-page="config">
      <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
      <main className="main">
        <div className="config-shell" data-active-section={activeSection}>
          <aside className="config-shell__side">
            <nav className="config-shell__nav" aria-label="Settings">
              {CONFIG_NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === item.id}
                  className={
                    activeSection === item.id
                      ? "config-shell__nav-item active"
                      : "config-shell__nav-item"
                  }
                  onClick={() => setActiveSection(item.id)}
                >
                  <span>{item.label}</span>
                  {item.id === "capabilities" ? (
                    <span className="config-shell__nav-badge">cascading</span>
                  ) : null}
                </button>
              ))}
            </nav>
          </aside>
          <div
            className={`config-shell__content${contentIsCapabilities ? " config-shell__content--capabilities" : ""}`}
          >
            <div className="config-shell__scroll">
              {activeSection === "general" && (
                <GeneralSection controller={controller} />
              )}
              {activeSection === "defaults" && (
                <DefaultsSection controller={controller} />
              )}
              {activeSection === "capabilities" && <CapabilitiesSection />}
              {activeSection === "backends" && (
                <BackendsSection controller={controller} />
              )}
              {activeSection === "workflow" && (
                <WorkflowSection controller={controller} />
              )}
              {activeSection === "limits" && (
                <LimitsSection controller={controller} />
              )}
              {activeSection === "notifications" && (
                <NotificationsSection controller={controller} />
              )}
            </div>
            {!contentIsCapabilities ? (
              <ConfigSaveBar
                dirtyCount={dirtyCount}
                saving={mutation.isPending}
                onRevert={revert}
                onSave={handleSave}
              />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
