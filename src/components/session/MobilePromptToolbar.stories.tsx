"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";

import MobilePromptToolbar, {
  MOBILE_PROMPT_ROW_CLASS,
} from "@/components/session/MobilePromptToolbar";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { SEND_BUTTON_CLASS } from "@/components/session/prompt/PromptDesktopToolbar";
import { Spinner } from "@/components/ui/Spinner";
import {
  backendLabel,
  getStaticBackendModelCatalog,
} from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

import { fullModelParameterCatalog } from "./prompt/model-selection-story-data";

interface DemoProps {
  initialBackend?: AgentBackendId;
  initialModel?: string;
  /** Starts on a specific variant instead of the model's default one. */
  initialParameters?: Record<string, string>;
  backendLocked?: boolean;
  catalogUnavailable?: boolean;
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

function catalogForBackend(backend: AgentBackendId): BackendModelCatalog {
  if (backend === "cursor") return fullModelParameterCatalog;
  return getStaticBackendModelCatalog(backend);
}

function initialSelection(
  catalog: BackendModelCatalog,
  preferredModel: string | undefined,
  parameters?: Record<string, string>,
): BackendModelSelection {
  const modelId = catalog.models.some(({ id }) => id === preferredModel)
    ? preferredModel!
    : catalog.defaultModelId;
  const selection = defaultSelectionForModel(catalog, modelId);
  return parameters === undefined ? selection : { modelId, parameters };
}

function McpRowStub({
  enabled,
  total,
  hasOverrides,
}: {
  enabled: number;
  total: number;
  hasOverrides?: boolean;
}): React.JSX.Element {
  const meta =
    total === 0
      ? "No servers configured"
      : `${enabled} of ${total} enabled${hasOverrides ? " · overrides set" : ""}`;
  return (
    <button type="button" className={MOBILE_PROMPT_ROW_CLASS} onClick={fn()}>
      <span
        className="flex h-[28px] w-[28px] shrink-0 items-center justify-center font-mono text-[0.85rem] text-text-secondary"
        aria-hidden
      >
        ⚙
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2xs">
        <span className="font-medium text-text-primary">MCP servers</span>
        <span className="text-[0.7rem] text-text-tertiary">{meta}</span>
      </span>
      {total > 0 ? (
        <span className="inline-flex items-center rounded-sm bg-bg-raised px-sm py-2xs font-mono text-[0.7rem] font-medium text-text-secondary">
          {enabled}/{total}
        </span>
      ) : null}
    </button>
  );
}

function DemoToolbar({
  initialBackend = "cursor",
  initialModel,
  initialParameters,
  backendLocked = false,
  catalogUnavailable = false,
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
}: DemoProps): React.JSX.Element {
  const [backend, setBackend] = useState<AgentBackendId>(initialBackend);
  const catalog = catalogForBackend(backend);
  const [selection, setSelection] = useState<BackendModelSelection>(() =>
    initialSelection(catalog, initialModel, initialParameters),
  );
  const [debug, setDebug] = useState(initialDebug);
  const [text, setText] = useState("");

  const changeBackend = (nextBackend: AgentBackendId): void => {
    const nextCatalog = catalogForBackend(nextBackend);
    setBackend(nextBackend);
    setSelection(
      defaultSelectionForModel(nextCatalog, nextCatalog.defaultModelId),
    );
  };

  return (
    <div className="shrink-0 border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-sm py-xs">
      <div className="relative flex flex-col gap-sm">
        <textarea
          className="prompt-textarea min-h-11 max-h-[120px]"
          placeholder={
            isReadOnly
              ? "Session is merged and read-only"
              : `Send a prompt to ${backendLabel(backend)}...`
          }
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={isReadOnly}
        />
        <MobilePromptToolbar
          modelCatalog={catalogUnavailable ? null : catalog}
          modelSelection={selection}
          modelSelectionBlockedReason={
            catalogUnavailable
              ? "The project-effective model catalog is unavailable."
              : null
          }
          onModelSelectionChange={setSelection}
          backend={backend}
          backendLocked={backendLocked}
          onSelectBackend={changeBackend}
          onAttach={fn()}
          attachDisabled={attachDisabled}
          debugActive={debug}
          debugSupported
          onToggleDebug={() => setDebug((current) => !current)}
          mcpRow={
            <McpRowStub
              enabled={mcpEnabledCount}
              total={mcpTotalCount}
              hasOverrides={mcpHasOverrides}
            />
          }
          isReadOnly={isReadOnly}
          isBusy={isBusy}
          voiceButton={
            <VoiceRecordButton
              isRecording={isRecording}
              isProcessing={false}
              elapsedTime={isRecording ? 5 : 0}
              isAvailable={voiceAvailable}
              toggleRecording={fn()}
              disabled={sending}
            />
          }
          sendButton={
            <button
              type="button"
              className={SEND_BUTTON_CLASS}
              data-busy={sending}
              disabled={
                (!text.trim() && !sending) ||
                isReadOnly ||
                isRecording ||
                catalogUnavailable
              }
              title={
                catalogUnavailable
                  ? "The project-effective model catalog is unavailable."
                  : sending
                    ? "Session is busy"
                    : "Send prompt"
              }
            >
              {sending ? <Spinner size="sm" tone="inherit" /> : "\u25B6"}
            </button>
          }
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Mobile/MobilePromptToolbar",
  component: DemoToolbar,
  parameters: {
    a11y: { test: "error" },
    viewport: { defaultViewport: "mobile1" },
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="mx-auto flex min-h-dvh max-w-[390px] flex-col justify-end bg-bg-base">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DemoToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Cursor's primary reasoning value is visible in the chip; the sheet exposes every advanced parameter. */
export const FullCursorParameters: Story = {};

/** Tap the model chip to inspect draft validation and atomic Apply/Cancel behavior. */
export const ModelOptionsSheet: Story = {};

/** Tap + for attachments, backend switching, debug, and MCP controls. */
export const MoreSheet: Story = {};

export const ClaudeEffortOnly: Story = {
  args: { initialBackend: "claude", initialModel: "opus" },
};

export const CodexReasoningAndFast: Story = {
  args: { initialBackend: "codex", initialModel: "gpt-5.6-sol" },
};

/** A tier the catalog marks as exceeding the provider's scale rainbows the chip. */
export const ExceedsScaleTier: Story = {
  args: {
    initialParameters: {
      reasoning: "xhigh",
      thinking: "true",
      context: "272k",
      fast: "false",
      cyber: "false",
    },
  },
};

export const CatalogUnavailable: Story = {
  args: { catalogUnavailable: true },
};

export const BackendLocked: Story = { args: { backendLocked: true } };
export const DebugOn: Story = { args: { debugActive: true } };
export const Sending: Story = { args: { sending: true, isBusy: true } };
export const Recording: Story = { args: { isRecording: true } };
export const ReadOnly: Story = { args: { isReadOnly: true } };
export const NoMcpServers: Story = {
  args: { mcpEnabledCount: 0, mcpTotalCount: 0 },
};
export const McpOverrides: Story = {
  args: { mcpEnabledCount: 1, mcpTotalCount: 3, mcpHasOverrides: true },
};

export const VeryNarrow: Story = {
  decorators: [
    (Story) => (
      <div className="mx-auto flex min-h-dvh max-w-[360px] flex-col justify-end bg-bg-base">
        <Story />
      </div>
    ),
  ],
};
