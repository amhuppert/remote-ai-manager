import { useCallback, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { cn } from "@/lib/ui/cn";
import {
  CompactMarkdown,
  DocumentMarkdown,
  MessageMarkdown,
  SourceMappedDocumentMarkdown,
} from "./Markdown";
import MarkdownViewport from "./MarkdownViewport";
import { CANONICAL_MARKDOWN_SHOWCASE } from "./fixtures";

const meta = {
  title: "Components/Markdown/Canonical",
  component: DocumentMarkdown,
  args: {
    content: CANONICAL_MARKDOWN_SHOWCASE,
  },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    docs: {
      description: {
        component:
          "The four fixed Markdown intents share one semantic engine and use only Command Center theme tokens.",
      },
    },
  },
} satisfies Meta<typeof DocumentMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

type FrameSize = "narrow" | "panel" | "wide";
type FrameSurface = "base" | "surface";

const FRAME_WIDTH_CLASSES: Record<FrameSize, string> = {
  narrow: "w-[390px]",
  panel: "w-[760px]",
  wide: "w-[1040px]",
};

const FRAME_SURFACE_CLASSES: Record<FrameSurface, string> = {
  base: "bg-bg-base",
  surface: "bg-bg-surface",
};

function StoryFrame({
  children,
  label,
  size,
  surface = "surface",
}: {
  children: ReactNode;
  label: string;
  size: FrameSize;
  surface?: FrameSurface;
}) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-bg-void p-lg text-text-primary">
      <section
        aria-label={label}
        className={cn(
          "flex h-[760px] max-h-[calc(100vh-32px)] max-w-full flex-col overflow-hidden rounded-lg border border-solid border-border-default shadow-dropdown",
          FRAME_WIDTH_CLASSES[size],
          FRAME_SURFACE_CLASSES[surface],
        )}
      >
        <header className="shrink-0 border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-raised px-md py-sm font-mono text-[0.72rem] font-semibold tracking-[0.04em] text-text-secondary uppercase">
          {label}
        </header>
        {children}
      </section>
    </main>
  );
}

interface SourceMarker {
  heading: string;
  line: string;
  top: number;
}

function SourceMappedOverlayHost({ content }: { content: string }) {
  const [markers, setMarkers] = useState<readonly SourceMarker[]>([]);
  const rootRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;

    const mapped = Array.from(
      element.querySelectorAll<HTMLElement>("[data-cc-line]"),
    )
      .filter((element) => /^H[1-6]$/.test(element.tagName))
      .slice(0, 4)
      .map((element) => ({
        heading: element.getAttribute("data-cc-heading") ?? "Document block",
        line: element.getAttribute("data-cc-line") ?? "?",
        top: element.offsetTop,
      }));
    setMarkers(mapped);
  }, []);

  const overlay = (
    <div
      data-source-map-overlay
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-raised"
    >
      {markers.map((marker) => (
        <span
          key={`${marker.line}-${marker.heading}`}
          className="absolute right-sm flex h-[24px] min-w-[24px] items-center justify-center rounded-full border border-solid border-cyan-dim bg-bg-raised px-xs font-mono text-[0.7rem] font-semibold text-cyan shadow-[0_0_8px_var(--color-cyan-glow)]"
          style={{ top: marker.top }}
          title={`${marker.heading}, source line ${marker.line}`}
        >
          {marker.line}
        </span>
      ))}
    </div>
  );

  return (
    <MarkdownViewport overlay={overlay}>
      <SourceMappedDocumentMarkdown
        key={content}
        ref={rootRef}
        content={content}
      />
    </MarkdownViewport>
  );
}

export const DocumentWide: Story = {
  render: ({ content }) => (
    <StoryFrame label="Document intent · wide" size="wide">
      <MarkdownViewport>
        <DocumentMarkdown content={content} />
      </MarkdownViewport>
    </StoryFrame>
  ),
};

export const SourceMappedPanel: Story = {
  render: ({ content }) => (
    <StoryFrame label="Source-mapped document · panel" size="panel">
      <SourceMappedOverlayHost content={content} />
    </StoryFrame>
  ),
};

export const MessagePanel: Story = {
  render: ({ content }) => (
    <StoryFrame label="Message intent · panel" size="panel" surface="base">
      <div className="min-h-0 flex-1 overflow-y-auto p-lg">
        <MessageMarkdown content={content} />
      </div>
    </StoryFrame>
  ),
};

export const CompactNarrow: Story = {
  render: ({ content }) => (
    <StoryFrame label="Compact intent · narrow" size="narrow">
      <div className="min-h-0 flex-1 overflow-y-auto p-md">
        <CompactMarkdown content={content} />
      </div>
    </StoryFrame>
  ),
};

export const MarkdownViewportLoading: Story = {
  render: () => (
    <StoryFrame label="Markdown viewport · loading" size="panel">
      <MarkdownViewport isLoading>{null}</MarkdownViewport>
    </StoryFrame>
  ),
};

export const MarkdownViewportEmpty: Story = {
  render: () => (
    <StoryFrame label="Markdown viewport · empty" size="panel">
      <MarkdownViewport emptyMessage="No Markdown content is available.">
        {null}
      </MarkdownViewport>
    </StoryFrame>
  ),
};
