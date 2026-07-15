"use client";

import { type ComponentProps } from "react";
import SessionContent from "@/features/session/conversation/SessionContent";
import PromptInputSlot from "@/components/session/prompt/PromptInputSlot";
import ConversationDialogs from "@/features/session/dialogs/ConversationDialogs";
import MobileBottomBar from "@/features/session/mobile/MobileBottomBar";

type SessionContentProps = ComponentProps<typeof SessionContent>;
type MobileBottomBarProps = ComponentProps<typeof MobileBottomBar>;
type PromptInputSlotProps = ComponentProps<typeof PromptInputSlot>;
type ConversationDialogsProps = ComponentProps<typeof ConversationDialogs>;

export interface ConversationWorkspaceViewProps {
  contentProps: Omit<SessionContentProps, "promptInputSlot">;
  promptInputSlotProps: PromptInputSlotProps;
  mobileBottomBarProps: MobileBottomBarProps;
  dialogsProps: ConversationDialogsProps;
}

export default function ConversationWorkspaceView({
  contentProps,
  promptInputSlotProps,
  mobileBottomBarProps,
  dialogsProps,
}: ConversationWorkspaceViewProps): React.JSX.Element {
  return (
    <>
      <SessionContent
        {...contentProps}
        promptInputSlot={<PromptInputSlot {...promptInputSlotProps} />}
      />
      <MobileBottomBar {...mobileBottomBarProps} />
      <ConversationDialogs {...dialogsProps} />
    </>
  );
}
