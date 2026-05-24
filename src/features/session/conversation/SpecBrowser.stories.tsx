import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  SpecBrowserView,
  type SpecBrowserViewProps,
} from "@/features/session/conversation/SpecBrowser";

type Segment = "steering" | "features";

const MOCK_TREE = {
  steering: ["product.md", "tech.md", "structure.md", "logs.md"],
  specs: {
    "browser-notifications": ["requirements.md", "design.md", "tasks.md"],
    "command-autocomplete": ["requirements.md", "design.md"],
    "conversation-forking": [
      "requirements.md",
      "design.md",
      "tasks.md",
      "research.md",
    ],
    "dashboard-ui": ["requirements.md", "design.md", "tasks.md"],
    "diff-viewer": ["requirements.md", "design.md", "tasks.md"],
    "e2e-debugging-instrumentation": ["requirements.md", "design.md"],
    "focus-mode-viewer": ["requirements.md", "design.md"],
    "focus-session-initialization": [
      "requirements.md",
      "design.md",
      "tasks.md",
    ],
    "git-operations": ["requirements.md", "design.md", "tasks.md"],
    "hook-integration": ["requirements.md", "design.md", "tasks.md"],
    "hotkey-support": ["requirements.md", "design.md", "tasks.md"],
    "image-attachments": ["requirements.md", "design.md", "tasks.md"],
    "project-discovery": ["requirements.md", "design.md"],
    "prompt-execution": ["requirements.md", "design.md", "tasks.md"],
    "session-lifecycle": ["requirements.md", "design.md", "tasks.md"],
    "smart-merge": ["requirements.md", "design.md"],
    "transcript-viewer": ["requirements.md", "design.md", "tasks.md"],
    "unified-conversations-panel": [
      "requirements.md",
      "design.md",
      "tasks.md",
      "research.md",
    ],
    "voice-transcription-integration": ["requirements.md", "design.md"],
    "worktree-import": ["requirements.md", "design.md", "tasks.md"],
  },
};

const MOCK_CONTENT = `# Design Document — Browser Notifications

## Overview

**Purpose**: Provide real-time browser notifications for important session events such as prompt completions, errors, and status changes.

### Goals

- Notify users when a long-running prompt completes
- Alert on SDK errors or timeouts
- Support user preference configuration for notification types

## Architecture

The notification system uses the **Web Notifications API** with a permission-gated approach.

### Components

| Component | Purpose |
|-----------|---------|
| NotificationManager | Central dispatch for all notification events |
| NotificationPrefs | User preference storage via localStorage |
| NotificationBanner | In-app fallback when browser permissions denied |

### Data Flow

\`\`\`
SSE Event → NotificationManager → Web Notification API
                                → In-app Banner (fallback)
\`\`\`

## Implementation

### Permission Flow

1. User enables notifications via settings toggle
2. \`Notification.requestPermission()\` called
3. Permission state persisted in \`NotificationPrefs\`
4. Future events dispatched based on stored preference

### Event Types

- \`prompt.complete\` — Session prompt finished successfully
- \`prompt.error\` — SDK returned an error
- \`session.status\` — Session status changed (running → awaiting)
`;

const MOCK_STEERING_CONTENT = `# Product Overview

CC (Command Center) is a web-based control plane for managing remote Claude Code coding sessions. It allows developers to create, monitor, and interact with multiple isolated Claude Code instances — each running in its own git worktree — through a centralized dashboard.

## Core Capabilities

1. **Project Discovery** — Scans a configurable base directory for git repositories
2. **Session Lifecycle** — Creates isolated coding sessions backed by git worktrees
3. **Prompt Execution** — Sends prompts via the Claude Agent SDK
4. **Live Observability** — Stores conversation transcripts as JSONL files
5. **Real-Time Status** — Broadcasts status changes via SSE
`;

/** Fully interactive wrapper using local state */
function SpecBrowserInteractive(
  overrides: Partial<SpecBrowserViewProps>,
): React.JSX.Element {
  const [segment, setSegment] = useState<Segment>(
    overrides.segment ?? "features",
  );
  const [expandedFeature, setExpandedFeature] = useState<string | null>(
    overrides.expandedFeature ?? null,
  );
  const [selection, setSelection] = useState<{
    category: string;
    file: string | null;
  } | null>(overrides.selection ?? null);

  const fileContent =
    selection?.file && selection.category === "steering"
      ? MOCK_STEERING_CONTENT
      : selection?.file
        ? MOCK_CONTENT
        : null;

  return (
    <SpecBrowserView
      tree={MOCK_TREE}
      isLoading={false}
      selection={selection}
      fileContent={fileContent}
      isFileLoading={false}
      segment={segment}
      expandedFeature={expandedFeature}
      onSegmentChange={setSegment}
      onExpandFeature={setExpandedFeature}
      onSelectFile={(category, file) => {
        setSelection({ category, file });
        setSegment(category === "steering" ? "steering" : "features");
        if (category !== "steering") setExpandedFeature(category);
      }}
      onGoBack={() => {
        if (selection) {
          setSegment(
            selection.category === "steering" ? "steering" : "features",
          );
          if (selection.category !== "steering")
            setExpandedFeature(selection.category);
          setSelection({ category: selection.category, file: null });
        }
      }}
      {...overrides}
    />
  );
}

const meta = {
  title: "Session/SpecBrowser",
  component: SpecBrowserInteractive,
  decorators: [
    (Story) => (
      <div
        style={{
          height: 600,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpecBrowserInteractive>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: Features segment with no file selected */
export const FeaturesNav: Story = {};

/** Steering segment showing steering files */
export const SteeringNav: Story = {
  args: { segment: "steering" },
};

/** Content view: viewing a feature spec file */
export const FeatureContent: Story = {
  args: {
    segment: "features",
    expandedFeature: "browser-notifications",
    selection: { category: "browser-notifications", file: "design.md" },
  },
};

/** Content view: viewing a steering file */
export const SteeringContent: Story = {
  args: {
    segment: "steering",
    selection: { category: "steering", file: "product.md" },
  },
};

/** Loading state */
export const Loading: Story = {
  render: () => (
    <SpecBrowserView
      tree={null}
      isLoading={true}
      selection={null}
      fileContent={null}
      isFileLoading={false}
      segment="features"
      expandedFeature={null}
      onSegmentChange={() => {}}
      onExpandFeature={() => {}}
      onSelectFile={() => {}}
      onGoBack={() => {}}
    />
  ),
};

/** Empty state: no specs or steering files */
export const Empty: Story = {
  render: () => (
    <SpecBrowserView
      tree={{ steering: [], specs: {} }}
      isLoading={false}
      selection={null}
      fileContent={null}
      isFileLoading={false}
      segment="features"
      expandedFeature={null}
      onSegmentChange={() => {}}
      onExpandFeature={() => {}}
      onSelectFile={() => {}}
      onGoBack={() => {}}
    />
  ),
};

/** Mobile width */
export const MobileWidth: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
