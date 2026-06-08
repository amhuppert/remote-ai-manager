"use client";

import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import DebugModeToggle from "@/features/session/debug/DebugModeToggle";
import DebugStatusStrip from "@/features/session/debug/DebugStatusStrip";
import DebugActionCard from "@/features/session/debug/DebugActionCard";
import type { ConversationState } from "@/lib/conversations/schemas";
// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-123",
    name: null,
    status: "awaiting",
    transcriptPath: "/tmp/test.jsonl",
    totalCostUsd: 0,
    totalDurationMs: 0,
    totalTurns: 0,
    promptCount: 2,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    source: "cc",
    summary: null,
    archived: false,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude" as const,
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
}

const debugModeActive = {
  active: true,
  recording: true,
  logFilePath: "/tmp/.debug/logs.jsonl",
  enteredAt: new Date().toISOString(),
  hypotheses: [],
  reproductionSteps: [],
  instructionsDelivered: true,
  phase: "hypothesizing" as const,
  fixSummary: null,
  verificationSteps: [],
  lastTurnFailed: false,
};

const debugModeRecordingPaused = {
  ...debugModeActive,
  recording: false,
};

// ---------------------------------------------------------------------------
// DebugModeToggle stories
// ---------------------------------------------------------------------------

/** Decorator that simulates the prompt toolbar context around the toggle */
const toolbarDecorator = (Story: React.ComponentType) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: 16,
      background: "var(--bg-base)",
    }}
  >
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        color: "var(--text-secondary)",
        padding: "0 12px",
        height: 36,
        display: "flex",
        alignItems: "center",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-surface)",
      }}
    >
      Opus
    </div>
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        color: "var(--text-secondary)",
        padding: "0 12px",
        height: 36,
        display: "flex",
        alignItems: "center",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-surface)",
      }}
    >
      High
    </div>
    <Story />
  </div>
);

const toggleMeta = {
  title: "Session/DebugMode/Toggle",
  component: DebugModeToggle,
  args: {
    projectName: "my-project",
    sessionName: "debug-session",
    conversation: makeConversation(),
  },
} satisfies Meta<typeof DebugModeToggle>;

export default toggleMeta;
type ToggleStory = StoryObj<typeof toggleMeta>;

export const Inactive: ToggleStory = {
  decorators: [toolbarDecorator],
};

export const Active: ToggleStory = {
  args: {
    conversation: makeConversation({ debugMode: debugModeActive }),
  },
  decorators: [toolbarDecorator],
};

export const Disabled: ToggleStory = {
  args: {
    disabled: true,
  },
  decorators: [toolbarDecorator],
};

// ---------------------------------------------------------------------------
// DebugStatusStrip stories (using a second meta via inline render)
// ---------------------------------------------------------------------------

export const StatusStripRecording: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <DebugStatusStrip
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({ debugMode: debugModeActive })}
      />
    </div>
  ),
};

export const StatusStripPaused: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <DebugStatusStrip
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({
          debugMode: debugModeRecordingPaused,
        })}
      />
    </div>
  ),
};

// ---------------------------------------------------------------------------
// DebugActionCard stories
// ---------------------------------------------------------------------------

const debugModeAwaitingReproduction = {
  ...debugModeActive,
  phase: "awaiting_reproduction" as const,
};

const debugModeAwaitingVerification = {
  ...debugModeActive,
  phase: "awaiting_verification" as const,
  fixSummary:
    "Patched the scroll handler to ignore wheel events during render.",
};

export const ActionCardAwaitingReproduction: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <DebugActionCard
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({
          debugMode: debugModeAwaitingReproduction,
          status: "awaiting",
        })}
        onSendPrompt={fn()}
        isBusy={false}
      />
    </div>
  ),
};

export const ActionCardAwaitingVerification: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-tertiary)",
          marginBottom: 8,
        }}
      >
        After analyze_evidence applies a fix, the user must adjudicate: Mark
        Fixed (success) or Mark Fix Failed (re-hypothesize).
      </p>
      <DebugActionCard
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({
          debugMode: debugModeAwaitingVerification,
          status: "awaiting",
        })}
        onSendPrompt={fn()}
        isBusy={false}
      />
    </div>
  ),
};

export const ActionCardBusy: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-tertiary)",
          marginBottom: 8,
        }}
      >
        When agent is busy: Mark Fixed and Mark Fix Failed are disabled, Exit
        Debug stays enabled:
      </p>
      <DebugActionCard
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({
          debugMode: debugModeAwaitingVerification,
          status: "awaiting",
        })}
        onSendPrompt={fn()}
        isBusy={true}
      />
    </div>
  ),
};

export const ActionCardHiddenWhileRunning: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-tertiary)",
        }}
      >
        Action card is hidden when conversation is running (nothing renders
        below):
      </p>
      <DebugActionCard
        projectName="my-project"
        sessionName="debug-session"
        conversation={makeConversation({
          debugMode: debugModeActive,
          status: "running",
        })}
        onSendPrompt={fn()}
        isBusy={true}
      />
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Full prompt area composition
// ---------------------------------------------------------------------------

export const FullPromptArea: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div className="prompt-input-area">
        <div className="prompt-input-wrapper">
          <DebugStatusStrip
            projectName="my-project"
            sessionName="debug-session"
            conversation={makeConversation({ debugMode: debugModeActive })}
          />
          <textarea
            className="prompt-textarea"
            placeholder="Send a prompt to Claude..."
            rows={1}
            readOnly
          />
          <div className="prompt-toolbar">
            <div className="prompt-toolbar-start">
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  color: "var(--text-secondary)",
                  padding: "0 12px",
                  height: 36,
                  display: "flex",
                  alignItems: "center",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-surface)",
                }}
              >
                Opus
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  color: "var(--text-secondary)",
                  padding: "0 12px",
                  height: 36,
                  display: "flex",
                  alignItems: "center",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--bg-surface)",
                }}
              >
                High
              </div>
              <DebugModeToggle
                projectName="my-project"
                sessionName="debug-session"
                conversation={makeConversation({
                  debugMode: debugModeActive,
                })}
              />
            </div>
            <div className="prompt-toolbar-end">
              <button
                className="send-btn"
                disabled
                style={{ width: 36, height: 36 }}
              >
                {"\u25B6"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Reproduction steps (CSS styling demo)
// ---------------------------------------------------------------------------

export const ReproductionStepsStyling: ToggleStory = {
  render: () => (
    <div style={{ maxWidth: 700, margin: "0 auto" }} data-debug-mode="">
      <div className="message assistant">
        <div className="message-role">CLAUDE</div>
        <div className="message-content">
          <p>
            I&apos;ve identified 3 hypotheses and instrumented the code. Please
            reproduce the bug by following these steps:
          </p>
          <blockquote>
            <p>
              <strong>Reproduction Steps</strong>
            </p>
            <ol>
              <li>Open the application and navigate to the Settings page</li>
              <li>Click on the sidebar scroll area</li>
              <li>Scroll up and down rapidly using the mouse wheel</li>
              <li>
                Observe the jittery scroll behavior — the page jumps back to the
                bottom
              </li>
            </ol>
          </blockquote>
        </div>
        <DebugActionCard
          projectName="my-project"
          sessionName="debug-session"
          conversation={makeConversation({
            debugMode: debugModeAwaitingReproduction,
            status: "awaiting",
          })}
          onSendPrompt={fn()}
          isBusy={false}
        />
      </div>
    </div>
  ),
};
