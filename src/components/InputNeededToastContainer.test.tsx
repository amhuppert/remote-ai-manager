// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNotificationStore } from "@/stores/notification.store";
import InputNeededToastContainer from "./InputNeededToastContainer";

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

describe("InputNeededToastContainer", () => {
  beforeEach(() => {
    pushMock.mockClear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("routes project-scoped input-needed toasts to the cockpit focus URL", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        scope: "project",
        projectName: "my-project",
        conversationId: "project-convo-1",
        displayContext: "main",
        href: "/projects/my-project?focus=project-convo-1",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("my-project / main")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith(
      "/projects/my-project?focus=project-convo-1",
    );
    expect(useNotificationStore.getState().inputToastQueue).toEqual([]);
  });

  it("keeps session input-needed toasts on the session conversation route", async () => {
    act(() => {
      useNotificationStore.getState().enqueueInputToast({
        projectName: "my-project",
        sessionName: "my-session",
        conversationId: "conv-1",
      });
    });

    render(<InputNeededToastContainer />);

    expect(screen.getByText("my-project / my-session")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(pushMock).toHaveBeenCalledWith(
      "/projects/my-project/my-session/conv-1",
    );
  });
});
