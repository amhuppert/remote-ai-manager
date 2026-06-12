// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isValidElement, Fragment, type ReactElement } from "react";
import ConversationWorkspaceView, {
  type ConversationWorkspaceViewProps,
} from "@/features/session/ConversationWorkspaceView";
import SessionContent from "@/features/session/conversation/SessionContent";
import MobileBottomBar from "@/features/session/mobile/MobileBottomBar";
import ConversationDialogs from "@/features/session/dialogs/ConversationDialogs";

/**
 * ConversationWorkspaceView is a pure shell that spreads prop bundles into its
 * child components. Full-tree rendering would require recreating the whole
 * provider surface; that coverage lives in `ConversationWorkspace.test.tsx` and each
 * child's own colocated test. Here we only verify the shell's own contract:
 * it renders no page chrome of its own (no `.app` / `main` wrapper — the host
 * shell owns those) and passes each bundle to the matching child.
 */

function makeProps(): ConversationWorkspaceViewProps {
  return {
    contentProps: {
      projectName: "repo",
    } as ConversationWorkspaceViewProps["contentProps"],
    promptInputSlotProps: {
      isWorkflowManagedConversation: true,
    } as ConversationWorkspaceViewProps["promptInputSlotProps"],
    mobileBottomBarProps:
      {} as ConversationWorkspaceViewProps["mobileBottomBarProps"],
    dialogsProps: {} as ConversationWorkspaceViewProps["dialogsProps"],
  };
}

function callComponent(props: ConversationWorkspaceViewProps): ReactElement {
  const result = (
    ConversationWorkspaceView as unknown as (
      p: ConversationWorkspaceViewProps,
    ) => ReactElement
  )(props);
  if (!isValidElement(result)) {
    throw new Error("ConversationWorkspaceView did not return a React element");
  }
  return result;
}

describe("ConversationWorkspaceView shell contract", () => {
  it("renders a fragment (no page chrome wrapper of its own)", () => {
    const element = callComponent(makeProps());
    expect(element.type).toBe(Fragment);
  });

  it("passes each prop bundle to the matching child component", () => {
    const props = makeProps();
    const element = callComponent(props);
    const children = (
      element.props as { children: ReactElement[] }
    ).children.filter(isValidElement);

    const types = children.map((child) => child.type);
    expect(types).toEqual([
      SessionContent,
      MobileBottomBar,
      ConversationDialogs,
    ]);

    const [content, bottomBar, dialogs] = children;
    expect((content!.props as { projectName?: string }).projectName).toBe(
      "repo",
    );
    expect(bottomBar!.props).toMatchObject(props.mobileBottomBarProps);
    expect(dialogs!.props).toMatchObject(props.dialogsProps);
  });
});
