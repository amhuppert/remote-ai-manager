"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import { Tabs, Tab, TabCount } from "@/components/ui/Tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/Accordion";
import MarkdownViewer from "@/components/MarkdownViewer";
import DocumentSurface from "@/features/session/document-viewer/DocumentSurface";
import type { DocumentRef } from "@/lib/document-comments/schemas";
import { useKiroDocTreeQuery, useKiroDocFileQuery } from "@/lib/kiro/queries";

// Shared file-item recipe (steering list + feature accordion). Differs only by
// left indent: steering items sit flush (12px); feature files are indented
// (30px) under their accordion group.
const SPEC_ITEM_BASE =
  "block w-full cursor-pointer border-y-0 border-r-0 border-l-2 border-solid border-l-transparent bg-transparent py-[5px] pr-[12px] text-left font-mono text-[0.72rem] font-normal text-text-secondary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-primary max-768:min-h-[44px] max-768:py-[10px] max-768:pr-[12px]";
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
  /**
   * Renderer for the selected file's body, injected by the app so specs render
   * through the comment-enabled annotated surface (selection/highlight/
   * commenting, req 2.1–2.3). When omitted (presentational stories) the plain
   * markdown viewer is rendered instead.
   */
  contentSlot?: React.ReactNode;
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
  contentSlot,
}: SpecBrowserViewProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
        <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
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
      <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
        <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
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
      <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
        <div className="flex shrink-0 items-center gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-subtle px-[12px] py-[8px]">
          <button
            className="flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent font-mono text-[1rem] text-text-secondary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-cyan max-768:h-[44px] max-768:w-[44px]"
            onClick={onGoBack}
            type="button"
          >
            &#8249;
          </button>
          <span className="truncate font-mono text-[0.72rem] font-semibold tracking-[0.06em] text-text-primary uppercase">
            {contextLabel}
          </span>
        </div>
        {currentFiles.length > 1 && (
          <Tabs>
            {currentFiles.map((file) => (
              <Tab
                key={file}
                active={selection!.file === file}
                onClick={() => onSelectFile(selection!.category, file)}
                type="button"
              >
                {formatFileName(file)}
              </Tab>
            ))}
          </Tabs>
        )}
        <div className="spec-browser-content flex min-h-0 flex-1 flex-col">
          {contentSlot ?? (
            <MarkdownViewer
              content={fileContent ?? null}
              isLoading={isFileLoading}
              emptyMessage="File not found."
            />
          )}
        </div>
      </div>
    );
  }

  // ─── Navigation view ───
  const sortedFeatures = Object.keys(tree.specs).sort();

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-b-lg border border-solid border-border-subtle bg-bg-surface">
      {showTabs && (
        <Tabs>
          <Tab
            active={effectiveSegment === "steering"}
            onClick={() => onSegmentChange("steering")}
            type="button"
          >
            Steering
          </Tab>
          <Tab
            active={effectiveSegment === "features"}
            onClick={() => onSegmentChange("features")}
            type="button"
          >
            Features
            <TabCount active={effectiveSegment === "features"}>
              {featureCount}
            </TabCount>
          </Tab>
        </Tabs>
      )}

      <div className="flex-1 overflow-y-auto py-xs">
        {effectiveSegment === "steering" ? (
          sortSpecFiles(tree.steering).map((file) => (
            <button
              key={file}
              className={cn(SPEC_ITEM_BASE, "pl-[12px]")}
              onClick={() => onSelectFile("steering", file)}
              type="button"
            >
              {formatFileName(file)}
            </button>
          ))
        ) : (
          <Accordion
            type="single"
            collapsible
            asChild
            value={expandedFeature ?? ""}
            onValueChange={(value) =>
              onExpandFeature(value === "" ? null : value)
            }
          >
            <div className="flex flex-col">
              {sortedFeatures.map((featureKey) => {
                const files = sortSpecFiles(tree.specs[featureKey] ?? []);
                return (
                  <AccordionItem key={featureKey} value={featureKey} asChild>
                    <div>
                      <AccordionTrigger asChild>
                        <button
                          className="group/spec-group flex w-full cursor-pointer items-center gap-[6px] border-0 bg-transparent px-[12px] py-[7px] text-left font-mono text-[0.72rem] font-medium text-text-secondary transition-all duration-150 ease-[ease] outline-none hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] data-[state=open]:text-text-primary max-768:min-h-[44px] max-768:py-[10px]"
                          type="button"
                        >
                          <span className="w-[16px] shrink-0 text-[0.72rem] text-text-tertiary transition-transform duration-150 group-data-[state=open]/spec-group:rotate-90">
                            {"\u25B8"}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {formatFeatureName(featureKey)}
                          </span>
                          <span className="shrink-0 rounded-[100px] bg-bg-raised px-[6px] py-[1px] text-[0.7rem] font-medium text-text-tertiary group-data-[state=open]/spec-group:bg-cyan-glow group-data-[state=open]/spec-group:text-cyan-dim">
                            {files.length}
                          </span>
                        </button>
                      </AccordionTrigger>
                      {/* asChild content is a generic <div>, NOT the file
                              list itself: Radix sets role="region" on it, which
                              would override a list role and orphan list items. */}
                      <AccordionContent asChild>
                        <div className="pt-[2px] pb-[6px]">
                          {files.map((file) => (
                            <button
                              key={file}
                              className={cn(SPEC_ITEM_BASE, "pl-[30px]")}
                              onClick={() => onSelectFile(featureKey, file)}
                              type="button"
                            >
                              {formatFileName(file)}
                            </button>
                          ))}
                        </div>
                      </AccordionContent>
                    </div>
                  </AccordionItem>
                );
              })}
            </div>
          </Accordion>
        )}
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

  // Specs live under `.kiro/` on disk; the canonical comment/content identity is
  // that worktree-relative path, so a spec opened here and the same file opened
  // from a transcript card or the Docs surface share one comment set (10.4).
  const specDocRef: DocumentRef | null =
    selectedFilePath && selection?.file
      ? {
          projectName,
          sessionName,
          docPath: `.kiro/${selectedFilePath}`,
          title: selection.file,
        }
      : null;

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
      contentSlot={
        specDocRef ? (
          <DocumentSurface
            docRef={specDocRef}
            content={fileQuery.data ?? null}
            isLoading={fileQuery.isPending}
            contentError={fileQuery.isError ? "error" : null}
          />
        ) : undefined
      }
    />
  );
}
