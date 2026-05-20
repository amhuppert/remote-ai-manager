"use client";

import { memo } from "react";
import dynamic from "next/dynamic";

const MarkdownContent = dynamic(() => import("./MarkdownContent"), {
  ssr: false,
});

interface Props {
  name: string;
  args: string | null;
}

export default memo(function CommandIndicator({
  name,
  args,
}: Props): React.JSX.Element {
  const expanded = args !== null && args.includes("\n");

  if (expanded) {
    return (
      <div className="command-indicator command-indicator--expanded">
        <span className="command-name">{name}</span>
        <div className="command-indicator__body">
          <MarkdownContent content={args} />
        </div>
      </div>
    );
  }

  return (
    <div className="command-indicator">
      <span className="command-name">{name}</span>
      {args && <span className="command-args">{args}</span>}
    </div>
  );
});
