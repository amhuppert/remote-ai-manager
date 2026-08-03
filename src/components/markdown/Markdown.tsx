"use client";

import {
  forwardRef,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from "react";

import { buildMarkdownDiffSource } from "./markdown-diff";

export type MarkdownProps = Readonly<{
  content: string;
}>;

/**
 * The comparison adapter's contract. It is deliberately NOT a variant of
 * `MarkdownProps`: a diff renders two revisions of one body, not one document
 * with rendering options, so the extra prop is a second document rather than a
 * configuration escape hatch.
 */
export type MarkdownDiffProps = Readonly<{
  before: string | null;
  after: string | null;
}>;

type MarkdownIntent = "document" | "message" | "compact";
type RendererProps = {
  content: string;
  intent: MarkdownIntent;
  sourceMapped: boolean;
  diff: boolean;
};
type Renderer = ForwardRefExoticComponent<
  RendererProps & RefAttributes<HTMLDivElement>
>;
type RendererModule = { default: Renderer };

const FALLBACK_CLASSES: Record<MarkdownIntent, string> = {
  document:
    "m-0 min-w-0 max-w-full whitespace-pre-wrap px-xl py-[20px] font-body text-[0.95rem] leading-[1.75] text-text-primary [overflow-wrap:anywhere] max-640:px-md max-640:py-lg",
  message:
    "m-0 min-w-0 max-w-full whitespace-pre-wrap font-body text-[0.9rem] leading-[1.65] text-text-primary [overflow-wrap:anywhere]",
  compact:
    "m-0 min-w-0 max-w-full whitespace-pre-wrap font-body text-[0.78rem] leading-[1.5] text-text-primary [overflow-wrap:anywhere]",
};

let rendererModulePromise: Promise<RendererModule> | null = null;

function loadRendererModule(): Promise<RendererModule> {
  rendererModulePromise ??= import("./MarkdownRenderer").then(
    ({ default: renderer }) => ({ default: renderer as Renderer }),
  );
  return rendererModulePromise;
}

const LazyMarkdownRenderer = lazy(loadRendererModule);

function MarkdownFallback({
  content,
  intent,
}: MarkdownProps & { intent: MarkdownIntent }) {
  return (
    <pre
      data-markdown-fallback
      aria-busy="true"
      className={FALLBACK_CLASSES[intent]}
    >
      {content}
    </pre>
  );
}

function DeferredMarkdown({
  content,
  intent,
  diff = false,
}: MarkdownProps & { intent: "message" | "compact"; diff?: boolean }) {
  const [LoadedRenderer, setLoadedRenderer] = useState<Renderer | null>(null);

  useEffect(() => {
    let active = true;
    void loadRendererModule().then(({ default: renderer }) => {
      if (active) setLoadedRenderer(() => renderer);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!LoadedRenderer) {
    return <MarkdownFallback content={content} intent={intent} />;
  }

  return (
    <LoadedRenderer
      content={content}
      intent={intent}
      sourceMapped={false}
      diff={diff}
    />
  );
}

export function DocumentMarkdown({ content }: MarkdownProps): ReactNode {
  return (
    <Suspense
      fallback={<MarkdownFallback content={content} intent="document" />}
    >
      <LazyMarkdownRenderer
        content={content}
        intent="document"
        sourceMapped={false}
        diff={false}
      />
    </Suspense>
  );
}

export const SourceMappedDocumentMarkdown = forwardRef<
  HTMLDivElement,
  MarkdownProps
>(function SourceMappedDocumentMarkdown({ content }, ref) {
  return (
    <Suspense
      fallback={<MarkdownFallback content={content} intent="document" />}
    >
      <LazyMarkdownRenderer
        ref={ref}
        content={content}
        intent="document"
        sourceMapped
        diff={false}
      />
    </Suspense>
  );
});

export function MessageMarkdown({ content }: MarkdownProps): ReactNode {
  return <DeferredMarkdown content={content} intent="message" />;
}

export function CompactMarkdown({ content }: MarkdownProps): ReactNode {
  return <DeferredMarkdown content={content} intent="compact" />;
}

/**
 * Renders two revisions of one body as a single formatted document whose
 * changed spans carry the added/removed colour. Passing the same string twice
 * (or one side alone) is well defined: an unchanged body renders as ordinary
 * Markdown, a one-sided body renders wholly marked.
 */
export function CompactMarkdownDiff({
  before,
  after,
}: MarkdownDiffProps): ReactNode {
  return (
    <DeferredMarkdown
      content={buildMarkdownDiffSource(before, after)}
      intent="compact"
      diff
    />
  );
}
