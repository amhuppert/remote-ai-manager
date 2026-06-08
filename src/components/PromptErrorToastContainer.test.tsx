// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNotificationStore } from "@/stores/notification.store";
import PromptErrorToastContainer from "./PromptErrorToastContainer";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function resetStore() {
  useNotificationStore.setState({
    jobs: new Map(),
    toastQueue: [],
    inputToastQueue: [],
    promptErrorQueue: [],
  });
}

describe("PromptErrorToastContainer", () => {
  beforeEach(() => {
    pushMock.mockClear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("routes project-scoped prompt error toasts to the cockpit focus URL", async () => {
    act(() => {
      useNotificationStore.getState().enqueuePromptErrorToast({
        scope: "project",
        projectName: "my-project",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/my-project?focus=project-convo-1",
        error: "Tool failed",
      });
    });

    render(<PromptErrorToastContainer />);

    expect(
      screen.getByText("my-project / main: Tool failed"),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith(
      "/projects/my-project?focus=project-convo-1",
    );
    expect(useNotificationStore.getState().promptErrorQueue).toEqual([]);
  });
});
