"use client";

import MarkdownViewer from "@/components/MarkdownViewer";
import { useKiroDocTreeQuery, useKiroDocFileQuery } from "@/lib/queries";
import {
  useSpecBrowserSelection,
  useSelectSpecCategory,
  useSelectSpecFile,
  useClearSpecSelection,
} from "@/stores/session-detail.store";

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

/** Build ordered category list from tree data */
function buildCategories(
  tree: { steering: string[]; specs: Record<string, string[]> } | undefined,
): { key: string; label: string; type: "steering" | "spec" }[] {
  if (!tree) return [];
  const result: { key: string; label: string; type: "steering" | "spec" }[] =
    [];
  if (tree.steering.length > 0) {
    result.push({ key: "steering", label: "Steering", type: "steering" });
  }
  const specNames = Object.keys(tree.specs).sort();
  for (const name of specNames) {
    result.push({
      key: name,
      label: formatFeatureName(name),
      type: "spec",
    });
  }
  return result;
}

/** Get files for the currently selected category */
function getFilesForCategory(
  tree: { steering: string[]; specs: Record<string, string[]> } | undefined,
  category: string | undefined,
): string[] {
  if (!tree || !category) return [];
  if (category === "steering") {
    return sortSpecFiles(tree.steering);
  }
  return sortSpecFiles(tree.specs[category] ?? []);
}

export default function SpecBrowser({
  projectName,
  sessionName,
}: SpecBrowserProps): React.JSX.Element {
  const treeQuery = useKiroDocTreeQuery(projectName, sessionName);
  const selection = useSpecBrowserSelection();
  const selectCategory = useSelectSpecCategory();
  const selectFile = useSelectSpecFile();
  const clearSelection = useClearSpecSelection();

  const selectedFilePath = buildFilePath(selection);
  const fileQuery = useKiroDocFileQuery(
    projectName,
    selectedFilePath,
    sessionName,
  );
  const categories = buildCategories(treeQuery.data);
  const files = getFilesForCategory(treeQuery.data, selection?.category);

  if (treeQuery.isPending) {
    return (
      <div className="spec-browser">
        <div className="spec-browser-empty">
          <div
            className="spinner"
            style={{
              borderColor: "rgba(0, 229, 255, 0.3)",
              borderTopColor: "var(--cyan)",
              width: 24,
              height: 24,
            }}
          />
          <span>Loading specs...</span>
        </div>
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <div className="spec-browser">
        <div className="spec-browser-empty">
          <span>No spec or steering files found.</span>
        </div>
      </div>
    );
  }

  const hasFileSelected = !!selection?.file;

  return (
    <div className="spec-browser" data-has-file={hasFileSelected || undefined}>
      {/* Navigation sidebar */}
      <div className="spec-browser-nav">
        {categories.map((cat) => {
          const isActive = selection?.category === cat.key;
          return (
            <div key={cat.key}>
              <button
                className={`spec-browser-category${isActive ? " active" : ""}`}
                onClick={() => {
                  if (isActive) {
                    clearSelection();
                  } else {
                    selectCategory(cat.key);
                  }
                }}
                type="button"
              >
                <span className="spec-browser-category-label">{cat.label}</span>
                {cat.type === "steering" && (
                  <span className="spec-browser-category-badge">steering</span>
                )}
              </button>
              {isActive && files.length > 0 && (
                <div className="spec-browser-files">
                  {files.map((file) => (
                    <button
                      key={file}
                      className={`spec-browser-file${selection?.file === file ? " active" : ""}`}
                      onClick={() => selectFile(cat.key, file)}
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

      {/* Content area */}
      <div className="spec-browser-content">
        {hasFileSelected && (
          <button
            className="spec-browser-back"
            onClick={() => selectCategory(selection!.category)}
            type="button"
          >
            &#8249; Back
          </button>
        )}
        {hasFileSelected ? (
          <MarkdownViewer
            content={fileQuery.data ?? null}
            isLoading={fileQuery.isPending}
            emptyMessage="File not found."
          />
        ) : (
          <div className="spec-browser-empty">
            <span>
              {selection?.category
                ? "Select a file to view."
                : "Select a category to browse specs."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
