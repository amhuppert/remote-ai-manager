// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isValidElement, type ReactElement } from "react";
import SessionPageView, {
  type SessionPageViewProps,
} from "@/features/session/SessionPageView";

/**
 * SessionPageView is a 44-line pure shell that spreads props into four child
 * components. Full-tree rendering would require recreating the whole provider
 * surface (TanStack Query + Zustand + Next router + Virtuoso polyfills + the
 * prompt-editor stub). That coverage already lives in `SessionPage.test.tsx`
 * and each child component's own colocated test, so here we only verify the
 * shell's own contract: it produces the documented root attributes and passes
 * each prop bundle through to the matching child.
 */

function makeProps(
  overrides: Partial<SessionPageViewProps> = {},
): SessionPageViewProps {
  return {
    mobilePanel: "chat",
    topbarProps: { projectName: "repo" } as SessionPageViewProps["topbarProps"],
    contentProps: {
      projectName: "repo",
    } as SessionPageViewProps["contentProps"],
    promptInputSlotProps: {
      isWorkflowManagedConversation: true,
    } as SessionPageViewProps["promptInputSlotProps"],
    mobileBottomBarProps: {} as SessionPageViewProps["mobileBottomBarProps"],
    dialogsProps: {} as SessionPageViewProps["dialogsProps"],
    ...overrides,
  };
}

function callComponent(props: SessionPageViewProps): ReactElement {
  const result = (
    SessionPageView as unknown as (p: SessionPageViewProps) => ReactElement
  )(props);
  if (!isValidElement(result)) {
    throw new Error("SessionPageView did not return a React element");
  }
  return result;
}

describe("SessionPageView shell contract", () => {
  it("renders a root <div> with data-page='detail' and the mobilePanel attribute", () => {
    const element = callComponent(makeProps({ mobilePanel: "diff" }));
    const elementProps = element.props as {
      className?: string;
      "data-page"?: string;
      "data-mobile-panel"?: string;
    };
    expect(element.type).toBe("div");
    expect(elementProps.className).toBe("app");
    expect(elementProps["data-page"]).toBe("detail");
    expect(elementProps["data-mobile-panel"]).toBe("diff");
  });

  it("propagates a different mobilePanel value to the root data attribute", () => {
    const element = callComponent(makeProps({ mobilePanel: "info" }));
    const elementProps = element.props as { "data-mobile-panel"?: string };
    expect(elementProps["data-mobile-panel"]).toBe("info");
  });

  it.todo(
    "renders SessionTopbar, SessionContent, MobileBottomBar, and ConversationDialogs — deeper assertions live in each child's own test",
  );
});
