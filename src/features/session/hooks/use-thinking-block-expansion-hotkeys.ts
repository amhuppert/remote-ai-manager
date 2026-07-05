"use client";

import { useCallback, useState } from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { ThinkingBlockExpansionCommand } from "@/components/ThinkingBlock";

export function useThinkingBlockExpansionHotkeys(
  enabled = true,
): ThinkingBlockExpansionCommand {
  const [command, setCommand] = useState<ThinkingBlockExpansionCommand>({
    expanded: true,
    revision: 0,
  });

  const expand = useCallback(() => {
    setCommand((prev) => ({
      expanded: true,
      revision: prev.revision + 1,
    }));
  }, []);

  const collapse = useCallback(() => {
    setCommand((prev) => ({
      expanded: false,
      revision: prev.revision + 1,
    }));
  }, []);

  useAppHotkey("expandThinkingBlocks", expand, { enabled });
  useAppHotkey("collapseThinkingBlocks", collapse, { enabled });

  return command;
}
