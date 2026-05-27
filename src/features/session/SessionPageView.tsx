"use client";

import { type ComponentProps } from "react";
import Topbar from "@/components/Topbar";
import SessionContent from "@/features/session/conversation/SessionContent";
import PromptInputSlot from "@/features/session/prompt/PromptInputSlot";
import ConversationDialogs from "@/features/session/dialogs/ConversationDialogs";
import MobileBottomBar from "@/features/session/mobile/MobileBottomBar";

type TopbarProps = ComponentProps<typeof Topbar>;
type SessionContentProps = ComponentProps<typeof SessionContent>;
type MobileBottomBarProps = ComponentProps<typeof MobileBottomBar>;
type PromptInputSlotProps = ComponentProps<typeof PromptInputSlot>;
type ConversationDialogsProps = ComponentProps<typeof ConversationDialogs>;

export interface SessionPageViewProps {
  mobilePanel: SessionContentProps["mobilePanel"];
  topbarProps: Pick<TopbarProps, "breadcrumbs">;
  contentProps: Omit<SessionContentProps, "promptInputSlot">;
  promptInputSlotProps: PromptInputSlotProps;
  mobileBottomBarProps: MobileBottomBarProps;
  dialogsProps: ConversationDialogsProps;
}

export default function SessionPageView({
  mobilePanel,
  topbarProps,
  contentProps,
  promptInputSlotProps,
  mobileBottomBarProps,
  dialogsProps,
}: SessionPageViewProps): React.JSX.Element {
  return (
    <div className="app" data-page="detail" data-mobile-panel={mobilePanel}>
      <Topbar page="detail" breadcrumbs={topbarProps.breadcrumbs} />
      <SessionContent
        {...contentProps}
        promptInputSlot={<PromptInputSlot {...promptInputSlotProps} />}
      />
      <MobileBottomBar {...mobileBottomBarProps} />
      <ConversationDialogs {...dialogsProps} />
    </div>
  );
}
