import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";

export interface MarkdownViewportProps {
  readonly isLoading?: boolean;
  readonly emptyMessage?: string;
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
}

const viewportClassName =
  "relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto";

const stateClassName =
  "flex min-h-[120px] items-center justify-center gap-sm px-lg py-xl font-mono text-[0.72rem] text-text-tertiary";

export default function MarkdownViewport({
  isLoading = false,
  emptyMessage = "No content available.",
  overlay,
  children,
}: MarkdownViewportProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div data-markdown-viewport className={viewportClassName}>
        <div role="status" aria-live="polite" className={stateClassName}>
          <Spinner />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  if (children === null || children === undefined || children === false) {
    return (
      <div data-markdown-viewport className={viewportClassName}>
        <div className={stateClassName}>{emptyMessage}</div>
      </div>
    );
  }

  return (
    <div data-markdown-viewport className={viewportClassName}>
      {children}
      {overlay}
    </div>
  );
}
