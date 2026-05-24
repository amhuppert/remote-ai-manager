"use client";

import { useState, useCallback, useEffect } from "react";

interface DevServerPreset {
  id: string;
  name: string;
  description: string;
  badge: string;
  files: string[];
}

const PRESETS: DevServerPreset[] = [
  {
    id: "nextjs",
    name: "Next.js",
    description: "Dev server with automatic port detection and HMR support",
    badge: "N",
    files: [".cc/dev-servers/nextjs.sh", "CommandCenter.json"],
  },
  {
    id: "storybook",
    name: "Storybook",
    description: "Component workshop with auto port allocation",
    badge: "S",
    files: [".cc/dev-servers/storybook.sh", "CommandCenter.json"],
  },
];

interface PresetInstallDialogProps {
  open: boolean;
  projectName: string;
  onInstall: (presetId: string, subdir?: string) => void;
  onClose: () => void;
  isInstalling?: boolean;
  installedPresets?: string[];
}

export default function PresetInstallDialog({
  open,
  projectName,
  onInstall,
  onClose,
  isInstalling = false,
  installedPresets = [],
}: PresetInstallDialogProps): React.JSX.Element | null {
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [subdir, setSubdir] = useState("");

  // Reset selection when modal opens
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSelectedPreset(null);
      setSubdir("");
    }
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isInstalling) onClose();
    },
    [onClose, isInstalling],
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  const canInstall = selectedPreset !== null && !isInstalling;
  const trimmedSubdir = subdir.trim().replace(/\/+$/, "");

  return (
    <div className="modal-overlay">
      <div className="modal preset-install-modal">
        <div className="modal-title">Install Dev Server Preset</div>
        <div className="preset-install-subtitle">
          Select a preset to install into{" "}
          <span className="preset-install-project">{projectName}</span>
        </div>

        <div className="preset-grid">
          {PRESETS.map((preset) => {
            const isInstalled = installedPresets.includes(preset.id);
            const isSelected = selectedPreset === preset.id;

            return (
              <button
                key={preset.id}
                type="button"
                className={`preset-card${isSelected ? " selected" : ""}${isInstalled ? " installed" : ""}`}
                onClick={() => {
                  if (!isInstalled && !isInstalling) {
                    setSelectedPreset(isSelected ? null : preset.id);
                  }
                }}
                disabled={isInstalled || isInstalling}
              >
                <div className="preset-card-header">
                  <span className="preset-card-badge">{preset.badge}</span>
                  <span className="preset-card-name">{preset.name}</span>
                  {isInstalled && (
                    <span className="preset-card-installed">Installed</span>
                  )}
                </div>
                <div className="preset-card-description">
                  {preset.description}
                </div>
                <div className="preset-card-files">
                  {preset.files.map((file) => (
                    <div key={file} className="preset-card-file">
                      {file}
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        {selectedPreset && (
          <div className="preset-subdir-field">
            <label
              className="preset-subdir-label"
              htmlFor="preset-subdir-input"
            >
              Subdirectory{" "}
              <span className="preset-subdir-optional">(optional)</span>
            </label>
            <input
              id="preset-subdir-input"
              type="text"
              className="preset-subdir-input"
              placeholder="e.g. dashboard-ui"
              value={subdir}
              onChange={(e) => setSubdir(e.target.value)}
              disabled={isInstalling}
            />
            <div className="preset-subdir-hint">
              For monorepos where the app lives in a subdirectory
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={isInstalling}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() =>
              selectedPreset &&
              onInstall(selectedPreset, trimmedSubdir || undefined)
            }
            disabled={!canInstall}
          >
            {isInstalling ? "Installing..." : "Install Preset"}
          </button>
        </div>
      </div>
    </div>
  );
}
