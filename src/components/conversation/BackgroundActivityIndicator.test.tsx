// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import BackgroundActivityIndicator from "./BackgroundActivityIndicator";
import type {
  ConversationBackgroundActivity,
  ConversationBackgroundTaskView,
} from "@/lib/conversations/schemas";

const NOW = Date.parse("2026-07-28T10:10:00.000Z");

function task(
  overrides: Partial<ConversationBackgroundTaskView> = {},
): ConversationBackgroundTaskView {
  return {
    taskId: "task-a",
    description: "full regression suite",
    taskType: null,
    workflowName: null,
    subagentType: null,
    lastToolName: null,
    totalTokens: null,
    toolUses: null,
    startedAt: "2026-07-28T10:00:00.000Z",
    lastActivityAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

function activity(
  tasks: ConversationBackgroundTaskView[],
): ConversationBackgroundActivity {
  return { tasks, updatedAt: "2026-07-28T10:09:00.000Z" };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderAt(
  ui: React.ReactElement,
  nowMs: number = NOW,
): ReturnType<typeof render> {
  vi.useFakeTimers({ now: nowMs, shouldAdvanceTime: false });
  return render(ui);
}

describe("BackgroundActivityIndicator", () => {
  it("renders nothing while the conversation is streaming a turn", () => {
    const { container } = renderAt(
      <BackgroundActivityIndicator
        activity={activity([task()])}
        visible={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no background work", () => {
    const { container } = renderAt(
      <BackgroundActivityIndicator activity={null} visible />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the workflow a single local_workflow task belongs to", () => {
    renderAt(
      <BackgroundActivityIndicator
        activity={activity([
          task({
            taskType: "local_workflow",
            workflowName: "spec",
            lastActivityAt: "2026-07-28T10:09:00.000Z",
          }),
        ])}
        visible
      />,
    );

    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("workflow spec");
  });

  it("falls back to the task description, then the subagent type", () => {
    const { rerender } = renderAt(
      <BackgroundActivityIndicator activity={activity([task()])} visible />,
    );
    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("full regression suite");

    rerender(
      <BackgroundActivityIndicator
        activity={activity([
          task({ description: null, subagentType: "explorer" }),
        ])}
        visible
      />,
    );
    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("explorer");

    rerender(
      <BackgroundActivityIndicator
        activity={activity([task({ description: null })])}
        visible
      />,
    );
    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("background task");
  });

  it("counts the tasks when more than one is running", () => {
    renderAt(
      <BackgroundActivityIndicator
        activity={activity([
          task({ taskId: "a" }),
          task({ taskId: "b" }),
          task({ taskId: "c" }),
        ])}
        visible
      />,
    );

    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("3 background tasks");
  });

  it("reports the most recent liveness signal", () => {
    renderAt(
      <BackgroundActivityIndicator
        activity={activity([
          task({ taskId: "a", lastActivityAt: "2026-07-28T10:00:00.000Z" }),
          task({ taskId: "b", lastActivityAt: "2026-07-28T10:08:00.000Z" }),
        ])}
        visible
      />,
    );

    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("last activity 2m ago");
  });

  it("degrades to the start time when no progress signal has arrived yet", () => {
    renderAt(
      <BackgroundActivityIndicator
        activity={activity([
          task({
            startedAt: "2026-07-28T10:05:00.000Z",
            lastActivityAt: "2026-07-28T10:05:00.000Z",
          }),
        ])}
        visible
      />,
    );

    const chip = screen.getByTestId("background-activity-indicator");
    expect(chip).toHaveTextContent("started 5m ago");
    expect(chip).not.toHaveTextContent("last activity");
  });

  it("re-renders the relative time as the clock advances", () => {
    renderAt(
      <BackgroundActivityIndicator
        activity={activity([
          task({ lastActivityAt: "2026-07-28T10:09:00.000Z" }),
        ])}
        visible
      />,
    );
    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("last activity 1m ago");

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(
      screen.getByTestId("background-activity-indicator"),
    ).toHaveTextContent("last activity 3m ago");
  });
});
