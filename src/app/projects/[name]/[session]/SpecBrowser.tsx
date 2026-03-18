"use client";

import { useState, useCallback } from "react";
import MarkdownViewer from "@/components/MarkdownViewer";
import { useKiroDocTreeQuery, useKiroDocFileQuery } from "@/lib/queries";
import {
  useSpecBrowserSelection,
  useSelectSpecCategory,
  useSelectSpecFile,
} from "@/stores/session-detail.store";

type Segment = "steering" | "features";

type DocTree = { steering: string[]; specs: Record<string, string[]> };

interface SpecBrowserProps {
  projectName: string;
  sessionName: string;
}

/** Preferred ordering for common spec files */
const FILE_ORDER: Record<string, number> = {
  "requirements.md": 0,
  "design.md": 1,
  "tasks.md": 2,
  "research.md": 3,
  "gap-analysis.md": 4,
};

function sortSpecFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const oa = FILE_ORDER[a] ?? 99;
    const ob = FILE_ORDER[b] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
}

/** Convert "browser-notifications" → "Browser Notifications" */
function formatFeatureName(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Strip .md extension and title-case: "design.md" → "Design" */
function formatFileName(name: string): string {
  const base = name.replace(/\.md$/, "");
  return base
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Build the API path for the selected file */
function buildFilePath(
  selection: { category: string; file: string | null } | null,
): string | null {
  if (!selection?.file) return null;
  if (selection.category === "steering") {
    return `steering/${selection.file}`;
  }
  return `specs/${selection.category}/${selection.file}`;
}

/** Get files for the currently selected category */
function getFilesForCategory(
  tree: DocTree | null,
  category: string | undefined,
): string[] {
  if (!tree || !category) return [];
  if (category === "steering") {
    return sortSpecFiles(tree.steering);
  }
  return sortSpecFiles(tree.specs[category] ?? []);
}

// ─── Presentational view component (exported for stories) ───

export interface SpecBrowserViewProps {
  tree: DocTree | null;
  isLoading: boolean;
  selection: { category: string; file: string | null } | null;
  fileContent: string | null;
  isFileLoading: boolean;
  segment: Segment;
  expandedFeature: string | null;
  onSegmentChange: (segment: Segment) => void;
  onExpandFeature: (feature: string | null) => void;
  onSelectFile: (category: string, file: string) => void;
  onGoBack: () => void;
}

export function SpecBrowserView({
  tree,
  isLoading,
  selection,
  fileContent,
  isFileLoading,
  segment,
  expandedFeature,
  onSegmentChange,
  onExpandFeature,
  onSelectFile,
  onGoBack,
}: SpecBrowserViewProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="spec-browser">
        <div className="spec-browser-empty">
          <div className="spinner" style={{ width: 24, height: 24 }} />
          <span>Loading specs...</span>
        </div>
      </div>
    );
  }

  if (
    !tree ||
    (tree.steering.length === 0 && Object.keys(tree.specs).length === 0)
  ) {
    return (
      <div className="spec-browser">
        <div className="spec-browser-empty">
          <span>No spec or steering files found.</span>
        </div>
      </div>
    );
  }

  const hasSteering = tree.steering.length > 0;
  const hasFeatures = Object.keys(tree.specs).length > 0;
  const featureCount = Object.keys(tree.specs).length;
  const showTabs = hasSteering && hasFeatures;
  const effectiveSegment =
    segment === "steering" && !hasSteering ? "features" : segment;
  const hasFileSelected = !!selection?.file;

  // ─── Content view (file selected) ───
  if (hasFileSelected) {
    const isSteeringFile = selection!.category === "steering";
    const contextLabel = isSteeringFile
      ? "Steering"
      : formatFeatureName(selection!.category);
    const currentFiles = getFilesForCategory(tree, selection!.category);

    return (
      <div className="spec-browser">
        <div className="spec-browser-header">
          <button
            className="spec-browser-back"
            onClick={onGoBack}
            type="button"
          >
            &#8249;
          </button>
          <span className="spec-browser-context">{contextLabel}</span>
        </div>
        {currentFiles.length > 1 && (
          <div className="cc-tabs">
            {currentFiles.map((file) => (
              <button
                key={file}
                className={`cc-tab${selection!.file === file ? " active" : ""}`}
                onClick={() => onSelectFile(selection!.category, file)}
                type="button"
              >
                {formatFileName(file)}
              </button>
            ))}
          </div>
        )}
        <div className="spec-browser-content">
          <MarkdownViewer
            content={fileContent ?? null}
            isLoading={isFileLoading}
            emptyMessage="File not found."
          />
        </div>
      </div>
    );
  }

  // ─── Navigation view ───
  const sortedFeatures = Object.keys(tree.specs).sort();

  return (
    <div className="spec-browser">
      {showTabs && (
        <div className="cc-tabs">
          <button
            className={`cc-tab${effectiveSegment === "steering" ? " active" : ""}`}
            onClick={() => onSegmentChange("steering")}
            type="button"
          >
            Steering
          </button>
          <button
            className={`cc-tab${effectiveSegment === "features" ? " active" : ""}`}
            onClick={() => onSegmentChange("features")}
            type="button"
          >
            Features
            <span className="cc-tab-count">{featureCount}</span>
          </button>
        </div>
      )}

      <div className="spec-browser-list">
        {effectiveSegment === "steering"
          ? sortSpecFiles(tree.steering).map((file) => (
              <button
                key={file}
                className="spec-browser-item"
                onClick={() => onSelectFile("steering", file)}
                type="button"
              >
                {formatFileName(file)}
              </button>
            ))
          : sortedFeatures.map((featureKey) => {
              const isExpanded = expandedFeature === featureKey;
              const files = sortSpecFiles(tree.specs[featureKey] ?? []);
              return (
                <div key={featureKey}>
                  <button
                    className={`spec-browser-group${isExpanded ? " expanded" : ""}`}
                    onClick={() =>
                      onExpandFeature(isExpanded ? null : featureKey)
                    }
                    type="button"
                  >
                    <span className="spec-browser-group-chevron">
                      {isExpanded ? "\u25BE" : "\u25B8"}
                    </span>
                    <span className="spec-browser-group-name">
                      {formatFeatureName(featureKey)}
                    </span>
                    <span className="spec-browser-group-count">
                      {files.length}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="spec-browser-group-files">
                      {files.map((file) => (
                        <button
                          key={file}
                          className="spec-browser-item"
                          onClick={() => onSelectFile(featureKey, file)}
                          type="button"
                        >
                          {formatFileName(file)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ─── Data-fetching wrapper (default export) ───

export default function SpecBrowser({
  projectName,
  sessionName,
}: SpecBrowserProps): React.JSX.Element {
  const treeQuery = useKiroDocTreeQuery(projectName, sessionName);
  const selection = useSpecBrowserSelection();
  const selectCategory = useSelectSpecCategory();
  const selectFile = useSelectSpecFile();

  const [segment, setSegment] = useState<Segment>("features");
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);

  const selectedFilePath = buildFilePath(selection);
  const fileQuery = useKiroDocFileQuery(
    projectName,
    selectedFilePath,
    sessionName,
  );

  const handleSelectFile = useCallback(
    (category: string, file: string) => {
      selectFile(category, file);
      setSegment(category === "steering" ? "steering" : "features");
      if (category !== "steering") {
        setExpandedFeature(category);
      }
    },
    [selectFile],
  );

  const handleGoBack = useCallback(() => {
    if (selection) {
      setSegment(selection.category === "steering" ? "steering" : "features");
      if (selection.category !== "steering") {
        setExpandedFeature(selection.category);
      }
      selectCategory(selection.category);
    }
  }, [selection, selectCategory]);

  return (
    <SpecBrowserView
      tree={treeQuery.data ?? null}
      isLoading={treeQuery.isPending}
      selection={selection}
      fileContent={fileQuery.data ?? null}
      isFileLoading={fileQuery.isPending}
      segment={segment}
      expandedFeature={expandedFeature}
      onSegmentChange={setSegment}
      onExpandFeature={setExpandedFeature}
      onSelectFile={handleSelectFile}
      onGoBack={handleGoBack}
    />
  );
}
