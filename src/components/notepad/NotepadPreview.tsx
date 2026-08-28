"use client";

import { useEffect, useState, type ComponentType } from "react";

export interface NotepadPreviewProps {
  notepadId: string;
  /** Canonical notepad text — typically the editor's serialized output. */
  content: string;
}

interface RendererProps {
  notepadId: string;
  content: string;
}

type RendererModule = { default: ComponentType<RendererProps> };

// Deferred like the canonical Markdown adapter: the react-markdown pipeline
// stays out of the initial bundle, with the raw text standing in meanwhile.
let rendererModulePromise: Promise<RendererModule> | null = null;

function loadRendererModule(): Promise<RendererModule> {
  rendererModulePromise ??=
    import("@/components/markdown/NotepadMarkdownRenderer");
  return rendererModulePromise;
}

// Editor keystrokes arrive per input event; re-parsing the whole document on
// every one is waste the reader cannot perceive being skipped.
const PREVIEW_DEBOUNCE_MS = 150;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function NotepadPreview({
  notepadId,
  content,
}: NotepadPreviewProps): React.JSX.Element {
  const debounced = useDebouncedValue(content, PREVIEW_DEBOUNCE_MS);
  const [Renderer, setRenderer] = useState<ComponentType<RendererProps> | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void loadRendererModule().then(({ default: renderer }) => {
      if (active) setRenderer(() => renderer);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div data-testid="notepad-preview" className="max-w-full min-w-0">
      {Renderer ? (
        <Renderer notepadId={notepadId} content={debounced} />
      ) : (
        <pre
          data-markdown-fallback
          aria-busy="true"
          className="m-0 max-w-full min-w-0 font-body text-[0.95rem] leading-[1.75] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-primary"
        >
          {debounced}
        </pre>
      )}
    </div>
  );
}
