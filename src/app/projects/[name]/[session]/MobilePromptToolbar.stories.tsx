"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import MobilePromptToolbar, {
  type MobilePromptToolbarProps,
} from "./MobilePromptToolbar";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import {
  clampEffortToModel,
  getEffortLevelsForBackend,
  type AgentBackendId,
  type ClaudeModel,
  type EffortLevel,
} from "@/lib/schemas";

const CLAUDE_MODELS = [
  { id: "opus", label: "Opus", description: "Most capable" },
  { id: "sonnet", label: "Sonnet", description: "Balanced" },
  { id: "haiku", label: "Haiku", description: "Fastest" },
];

const CODEX_MODELS = [
  { id: "gpt-5.5", label: "GPT-5.5", description: "Latest" },
  { id: "gpt-5.4", label: "GPT-5.4", description: "Most capable" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "Balanced" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", description: "Fastest" },
];

const ALL_EFFORT_OPTIONS = [
  { id: "minimal" as const, label: "Minimal", description: "Least reasoning" },
  { id: "low" as const, label: "Low", description: "Minimal" },
  { id: "medium" as const, label: "Medium", description: "Moderate" },
  { id: "high" as const, label: "High", description: "Default" },
  { id: "xhigh" as const, label: "XHigh", description: "Extra high" },
  { id: "max" as const, label: "Max", description: "Maximum" },
];

function effortOptionsFor(backend: AgentBackendId, model: string) {
  const allowed = new Set(getEffortLevelsForBackend(backend, model));
  return ALL_EFFORT_OPTIONS.filter((o) => allowed.has(o.id));
}

interface DemoProps {
  initialModel?: string;
  initialEffort?: EffortLevel;
  initialBackend?: AgentBackendId;
  backendLocked?: boolean;
  debugActive?: boolean;
  isReadOnly?: boolean;
  isBusy?: boolean;
  sending?: boolean;
  isRecording?: boolean;
  voiceAvailable?: boolean;
  mcpEnabledCount?: number;
  mcpTotalCount?: number;
  mcpHasOverrides?: boolean;
  attachDisabled?: boolean;
}

function McpRowStub({
  enabled,
  total,
  hasOverrides,
}: {
  enabled: number;
  total: number;
  hasOverrides?: boolean;
}) {
  const meta =
    total === 0
      ? "No servers configured"
      : `${enabled} of ${total} enabled${hasOverrides ? " · overrides set" : ""}`;
  return (
    <button type="button" className="mobile-prompt-row" onClick={fn()}>
      <span className="mobile-prompt-row__icon" aria-hidden>
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            fill="currentColor"
            d="M8 1.5a1.5 1.5 0 0 1 1.5 1.5v1.17a3.5 3.5 0 0 1 1.3.75l1.02-.59a1.5 1.5 0 0 1 2.05.55l.5.87a1.5 1.5 0 0 1-.55 2.05l-1.02.59a3.5 3.5 0 0 1 0 1.5l1.02.59a1.5 1.5 0 0 1 .55 2.05l-.5.87a1.5 1.5 0 0 1-2.05.55l-1.02-.59a3.5 3.5 0 0 1-1.3.75V13a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 5.5 13v-1.17a3.5 3.5 0 0 1-1.3-.75l-1.02.59a1.5 1.5 0 0 1-2.05-.55l-.5-.87a1.5 1.5 0 0 1 .55-2.05l1.02-.59a3.5 3.5 0 0 1 0-1.5l-1.02-.59a1.5 1.5 0 0 1-.55-2.05l.5-.87a1.5 1.5 0 0 1 2.05-.55l1.02.59a3.5 3.5 0 0 1 1.3-.75V3A1.5 1.5 0 0 1 6.5 1.5h1ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
          />
        </svg>
      </span>
      <span className="mobile-prompt-row__content">
        <span className="mobile-prompt-row__label">MCP servers</span>
        <span className="mobile-prompt-row__meta">{meta}</span>
      </span>
      <span className="mobile-prompt-row__trailing">
        {total > 0 && (
          <span className="mobile-prompt-badge">{`${enabled}/${total}`}</span>
        )}
        <span className="mobile-prompt-row__chevron" aria-hidden>
          {"\u203A"}
        </span>
      </span>
    </button>
  );
}

function DemoToolbar({
  initialModel = "opus",
  initialEffort = "xhigh",
  initialBackend = "claude",
  backendLocked = false,
  debugActive: initialDebug = false,
  isReadOnly = false,
  isBusy = false,
  sending = false,
  isRecording = false,
  voiceAvailable = true,
  mcpEnabledCount = 2,
  mcpTotalCount = 3,
  mcpHasOverrides = false,
  attachDisabled = false,
}: DemoProps) {
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<EffortLevel>(initialEffort);
  const [backend, setBackend] = useState<AgentBackendId>(initialBackend);
  const [debug, setDebug] = useState(initialDebug);
  const [text, setText] = useState("");

  const modelOptions = backend === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
  const effortOptions = effortOptionsFor(backend, model);
  const effortSupported = effortOptions.length > 0;
  const effortDisabledReason =
    backend === "claude" && model === "haiku"
      ? "Reasoning level is only available for Opus and Sonnet models"
      : undefined;

  const handleSelectModel = (id: string) => {
    setModel(id);
    if (backend === "claude") {
      const clamped = clampEffortToModel(effort, id as ClaudeModel);
      if (clamped && clamped !== effort) setEffort(clamped);
    } else {
      const allowed = getEffortLevelsForBackend(backend, id);
      if (allowed.length > 0 && !allowed.includes(effort)) {
        setEffort(allowed.includes("high") ? "high" : allowed[0]!);
      }
    }
  };

  const props: MobilePromptToolbarProps = {
    modelOptions,
    effortOptions,
    selectedModel: model,
    selectedEffort: effort,
    effortSupported,
    effortDisabledReason,
    onSelectModel: handleSelectModel,
    onSelectEffort: setEffort,
    backend,
    backendLocked,
    onSelectBackend: (b) => {
      setBackend(b);
      const next = b === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
      const nextModel = next.some((m) => m.id === model) ? model : next[0]!.id;
      setModel(nextModel);
      const allowed = getEffortLevelsForBackend(b, nextModel);
      if (allowed.length > 0 && !allowed.includes(effort)) {
        setEffort(allowed.includes("high") ? "high" : allowed[0]!);
      }
    },
    onAttach: fn(),
    attachDisabled,
    debugActive: debug,
    debugSupported: true,
    onToggleDebug: () => setDebug((v) => !v),
    debugDisabled: false,
    mcpRow: (
      <McpRowStub
        enabled={mcpEnabledCount}
        total={mcpTotalCount}
        hasOverrides={mcpHasOverrides}
      />
    ),
    isReadOnly,
    isBusy,
    voiceButton: (
      <VoiceRecordButton
        isRecording={isRecording}
        isProcessing={false}
        elapsedTime={isRecording ? 5 : 0}
        isAvailable={voiceAvailable}
        toggleRecording={fn()}
        disabled={sending}
      />
    ),
    sendButton: (
      <button
        type="button"
        className={`send-btn${sending ? " busy" : ""}`}
        disabled={(!text.trim() && !sending) || isReadOnly || isRecording}
        title={
          isReadOnly
            ? "Session is read-only"
            : sending
              ? "Session is busy"
              : "Send prompt"
        }
      >
        {sending ? (
          <div
            className="spinner"
            style={{
              borderColor: "rgba(0, 229, 255, 0.3)",
              borderTopColor: "var(--cyan)",
              width: 18,
              height: 18,
            }}
          />
        ) : (
          "\u25B6"
        )}
      </button>
    ),
  };

  return (
    <div className="prompt-input-area">
      <div className="prompt-input-wrapper">
        <textarea
          className="prompt-textarea"
          placeholder={
            isReadOnly
              ? "Session is merged and read-only"
              : "Send a prompt to Claude..."
          }
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ minHeight: 44, maxHeight: 120 }}
          disabled={isReadOnly}
        />
        <MobilePromptToolbar {...props} />
      </div>
    </div>
  );
}

const meta = {
  title: "Mobile/MobilePromptToolbar",
  component: DemoToolbar,
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 390,
          margin: "0 auto",
          minHeight: "100dvh",
          background: "var(--bg-base)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DemoToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default mobile prompt toolbar — Opus + XHigh chip with rainbow border. */
export const Default: Story = {};

/** Tap the chip to open the combined Model + Reasoning sheet. */
export const ChipOpen: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Tap the **Opus · XHigh** chip to open the combined model and reasoning level sheet.",
      },
    },
  },
};

/** Tap the + button to open the More sheet with attach, backend, debug, MCP. */
export const MoreOpen: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Tap the **+** button to open the More sheet (attach, backend, debug, MCP).",
      },
    },
  },
};

/** Backend lock state — once a conversation has started, Claude/Codex is fixed. */
export const BackendLocked: Story = {
  args: {
    backendLocked: true,
  },
};

/** Codex backend selected. Models list switches automatically. */
export const CodexBackend: Story = {
  args: {
    initialBackend: "codex",
    initialModel: "gpt-5.5",
  },
};

/** Reasoning unsupported — Haiku has no effort levels; chip shows only the model. */
export const ReasoningUnavailable: Story = {
  args: {
    initialModel: "haiku",
    initialEffort: "high",
  },
};

/** Sonnet — only Low/Medium/High are listed. Switch to Opus to unlock XHigh/Max. */
export const SonnetReducedLevels: Story = {
  args: {
    initialModel: "sonnet",
    initialEffort: "high",
  },
};

/** Debug mode active — amber dot in chip and on the row. */
export const DebugOn: Story = {
  args: {
    debugActive: true,
  },
};

/** Sending state — chip is disabled and send shows a spinner. */
export const Sending: Story = {
  args: {
    sending: true,
    isBusy: true,
  },
};

/** Recording — voice button shows a square + timer. */
export const Recording: Story = {
  args: {
    isRecording: true,
  },
};

/** Read-only session — every interactive element is disabled. */
export const ReadOnly: Story = {
  args: {
    isReadOnly: true,
  },
};

/** No MCP servers configured — row shows the empty state copy. */
export const NoMcpServers: Story = {
  args: {
    mcpEnabledCount: 0,
    mcpTotalCount: 0,
  },
};

/** MCP overrides at the conversation level. */
export const McpOverrides: Story = {
  args: {
    mcpEnabledCount: 1,
    mcpTotalCount: 3,
    mcpHasOverrides: true,
  },
};

/** Narrow Galaxy-style viewport (360px) — controls still fit. */
export const VeryNarrow: Story = {
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 360,
          margin: "0 auto",
          minHeight: "100dvh",
          background: "var(--bg-base)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
