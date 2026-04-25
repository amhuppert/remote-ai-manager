import { useState, useRef, useCallback, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { fuzzyMatch, compareFuzzyResults } from "@/lib/fuzzy";
import {
  FileAutocomplete,
  type FileAutocompleteHandle,
  type ScoredFileItem,
} from "./FileAutocomplete";

// ---------------------------------------------------------------------------
// Mock file data — representative of a real project
// ---------------------------------------------------------------------------

const MOCK_FILES = [
  "src/components/CommandAutocomplete.tsx",
  "src/components/CommandAutocomplete.test.tsx",
  "src/components/ConfirmDialog.tsx",
  "src/components/ConfirmDialog.stories.tsx",
  "src/components/FileAutocomplete.tsx",
  "src/components/Topbar.tsx",
  "src/components/ModelSelector.tsx",
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/projects/ProjectCard.tsx",
  "src/app/projects/ProjectCard.stories.tsx",
  "src/app/projects/[name]/CreateSessionModal.tsx",
  "src/app/projects/[name]/OptimisticDialog.tsx",
  "src/app/projects/[name]/[session]/ConversationDetailPage.tsx",
  "src/app/projects/[name]/[session]/LayoutSwitcher.tsx",
  "src/app/api/projects/[name]/sessions/route.ts",
  "src/app/api/projects/[name]/sessions/[session]/prompt/route.ts",
  "src/lib/fuzzy.ts",
  "src/lib/schemas.ts",
  "src/lib/queries.ts",
  "src/lib/mutations.ts",
  "src/lib/config.ts",
  "src/lib/state.ts",
  "src/lib/sessions.ts",
  "src/lib/prompt.ts",
  "src/lib/transcript.ts",
  "src/lib/commands.ts",
  "src/stores/notification.store.ts",
  "src/stores/sessions.store.ts",
  "src/stores/workflow.store.ts",
  "src/hooks/use-send-prompt.ts",
  "src/hooks/useAppHotkey.ts",
  "src/hooks/useVoiceRecorder.ts",
  "src/types/index.ts",
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  ".kiro/specs/ui-design-system/design.md",
  ".kiro/steering/product.md",
  ".kiro/steering/tech.md",
  "CLAUDE.md",
  "README.md",
];

function scoreFiles(query: string, files: string[]): ScoredFileItem[] {
  const results: ScoredFileItem[] = [];

  for (const path of files) {
    const result = fuzzyMatch(query, path);
    if (result.match) {
      results.push({
        item: { path },
        tier: result.tier!,
        coverage: result.coverage,
        indices: result.indices,
      });
    }
  }

  results.sort(
    (a, b) =>
      compareFuzzyResults(a, b) || a.item.path.localeCompare(b.item.path),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Interactive demo wrapper — simulates a textarea with @-trigger
// ---------------------------------------------------------------------------

function InteractiveDemo() {
  const [text, setText] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<FileAutocompleteHandle>(null);

  // Detect @-trigger: find the word starting with @ at or before the cursor
  const triggerInfo = useMemo(() => {
    // Walk backward from cursor to find the @ that starts the current word
    let start = cursorPos;
    while (start > 0 && text[start - 1] !== " " && text[start - 1] !== "\n") {
      start--;
    }
    const word = text.slice(start, cursorPos);
    if (word.startsWith("@")) {
      return { active: true, query: word.slice(1), start };
    }
    return { active: false, query: "", start: 0 };
  }, [text, cursorPos]);

  const items = useMemo(() => {
    if (!triggerInfo.active) return [];
    const scored = scoreFiles(triggerInfo.query, MOCK_FILES);
    return scored.slice(0, 20);
  }, [triggerInfo]);

  const totalCount = useMemo(() => {
    if (!triggerInfo.active) return 0;
    return scoreFiles(triggerInfo.query, MOCK_FILES).length;
  }, [triggerInfo]);

  const handleSelect = useCallback(
    (path: string) => {
      // Replace @query with @path
      const before = text.slice(0, triggerInfo.start);
      const after = text.slice(cursorPos);
      const newText = `${before}@${path} ${after}`;
      setText(newText);
      setSelectedFile(path);

      // Focus back on textarea
      const newCursorPosition = before.length + 1 + path.length + 1;
      setCursorPos(newCursorPosition);
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(newCursorPosition, newCursorPosition);
        }
      }, 0);
    },
    [text, triggerInfo.start, cursorPos],
  );

  const handleClose = useCallback(() => {
    // Remove the @query
    const before = text.slice(0, triggerInfo.start);
    const after = text.slice(cursorPos);
    setText(before + after);
  }, [text, triggerInfo.start, cursorPos]);

  return (
    <div
      style={{
        background: "var(--bg-void)",
        padding: "var(--space-lg)",
        minHeight: 400,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: "var(--space-md)",
      }}
    >
      <div
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          textAlign: "center",
        }}
      >
        Type <kbd style={kbdStyle}>@</kbd> to trigger file autocomplete. Try{" "}
        <code style={codeStyle}>@fuzzy</code>,{" "}
        <code style={codeStyle}>@schema</code>, or{" "}
        <code style={codeStyle}>@.tsx</code>
      </div>

      {selectedFile && (
        <div
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.68rem",
            textAlign: "center",
          }}
        >
          Selected: <span style={{ color: "var(--cyan)" }}>{selectedFile}</span>
        </div>
      )}

      <div style={{ position: "relative" }}>
        <FileAutocomplete
          ref={autocompleteRef}
          items={items}
          visible={triggerInfo.active}
          totalCount={totalCount}
          onSelect={handleSelect}
          onClose={handleClose}
        />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCursorPos(e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (autocompleteRef.current?.handleKeyDown(e)) return;
          }}
          onSelect={(e) => {
            setCursorPos((e.target as HTMLTextAreaElement).selectionStart);
          }}
          placeholder="Type a prompt... use @ to reference files"
          style={{
            width: "100%",
            minHeight: 80,
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.85rem",
            resize: "vertical",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0 4px",
  border: "1px solid var(--border-default)",
  borderRadius: 3,
  fontFamily: "var(--font-mono)",
  fontSize: "0.65rem",
  lineHeight: "1.4",
  color: "var(--text-secondary)",
  background: "var(--bg-raised)",
};

const codeStyle: React.CSSProperties = {
  color: "var(--cyan)",
  fontFamily: "var(--font-mono)",
};

// ---------------------------------------------------------------------------
// Static demo wrapper — shows the dropdown without interaction
// ---------------------------------------------------------------------------

function StaticDemo({
  items = [],
  loading = false,
  error = null,
  totalCount,
}: {
  items?: ScoredFileItem[];
  loading?: boolean;
  error?: string | null;
  totalCount?: number;
}) {
  return (
    <div
      style={{
        background: "var(--bg-void)",
        padding: "var(--space-lg)",
        minHeight: 400,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
      }}
    >
      <div style={{ position: "relative" }}>
        <FileAutocomplete
          items={items}
          visible={true}
          loading={loading}
          error={error}
          totalCount={totalCount}
          onSelect={fn()}
          onClose={fn()}
        />
        <div
          style={{
            width: "100%",
            height: 80,
            background: "var(--bg-base)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Components/FileAutocomplete",
  component: FileAutocomplete,
  args: {
    items: [],
    visible: true,
    onSelect: fn(),
    onClose: fn(),
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof FileAutocomplete>;

export default meta;

// Stories use custom render functions, so we type against the meta
// without requiring args for the wrapped component
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** Full interactive demo — type @ to trigger autocomplete */
export const Interactive: Story = {
  render: () => <InteractiveDemo />,
};

/** Default state with several files and first item active */
export const Default: Story = {
  render: () => <StaticDemo items={scoreFiles("", MOCK_FILES).slice(0, 12)} />,
};

/** Filtered by query "schema" — shows fuzzy match highlighting */
export const WithQuery: Story = {
  render: () => <StaticDemo items={scoreFiles("schema", MOCK_FILES)} />,
};

/** Filtered by ".tsx" — shows extension-based filtering */
export const FilterByExtension: Story = {
  render: () => (
    <StaticDemo items={scoreFiles(".tsx", MOCK_FILES).slice(0, 15)} />
  ),
};

/** Shows "10 of 42" truncation indicator in header */
export const ManyResults: Story = {
  render: () => (
    <StaticDemo
      items={scoreFiles("", MOCK_FILES).slice(0, 10)}
      totalCount={MOCK_FILES.length}
    />
  ),
};

/** Loading state */
export const Loading: Story = {
  render: () => <StaticDemo loading />,
};

/** Empty state — no matching files */
export const Empty: Story = {
  render: () => <StaticDemo items={[]} />,
};

/** Error state */
export const ErrorState: Story = {
  render: () => (
    <StaticDemo error="Failed to scan project files. Check server connection." />
  ),
};
