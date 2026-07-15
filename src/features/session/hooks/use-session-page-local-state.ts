"use client";

import { useEffect, useRef, useState } from "react";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import type { VirtuosoHandle } from "@/components/conversation/ConversationVirtuosoList";

export function useSessionPageLocalState(initialPromptText = "") {
  const [promptText, setPromptText] = useState(initialPromptText);
  const editorRef = useRef<PromptEditorHandle>(null);
  const promptTextRef = useRef(promptText);
  useEffect(() => {
    promptTextRef.current = promptText;
  }, [promptText]);
  const fireAndForgetRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();
  const [inlineMarkerIds, setInlineMarkerIds] = useState<string[]>([]);

  const panelBodyRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [collabPinnedTopTarget, setCollabPinnedTopTarget] =
    useState<HTMLDivElement | null>(null);
  const [collabRowEl, setCollabRowEl] = useState<HTMLDivElement | null>(null);

  return {
    promptText,
    setPromptText,
    editorRef,
    promptTextRef,
    fireAndForgetRef,
    fileInputRef,
    pendingImages,
    addImage,
    removeImage,
    clearImages,
    isAtLimit,
    inlineMarkerIds,
    setInlineMarkerIds,
    panelBodyRef,
    virtuosoRef,
    collabPinnedTopTarget,
    setCollabPinnedTopTarget,
    collabRowEl,
    setCollabRowEl,
  };
}
