"use client";

import { useState } from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import HotkeyHelpModal from "./HotkeyHelpModal";

export default function GlobalHotkeyHelp(): React.JSX.Element {
  const [showHelpModal, setShowHelpModal] = useState(false);

  useAppHotkey("helpModal", () => setShowHelpModal(true));

  return (
    <HotkeyHelpModal
      open={showHelpModal}
      onClose={() => setShowHelpModal(false)}
    />
  );
}
