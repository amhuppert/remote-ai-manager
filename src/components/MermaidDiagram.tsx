"use client";

import { useEffect, useId, useRef, useState, useCallback } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";

interface Props {
  /** Raw mermaid diagram source code */
  code: string;
}

/** Shared mermaid initialization config */
const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: "dark" as const,
  themeVariables: {
    darkMode: true,
    background: "transparent",
    primaryColor: "#0d3b66",
    primaryTextColor: "#e0e0e0",
    primaryBorderColor: "#00e5ff",
    lineColor: "#00e5ff",
    secondaryColor: "#1a1a2e",
    tertiaryColor: "#162447",
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
    fontSize: "14px",
  },
  flowchart: { curve: "basis" as const },
  securityLevel: "strict" as const,
};

/**
 * Renders a Mermaid diagram from source code.
 * Lazily imports the mermaid library and renders SVG client-side.
 * Click to expand into a fullscreen overlay with pan/zoom controls.
 * Falls back to a styled code block on parse/render errors.
 */
export default function MermaidDiagram({ code }: Props): React.JSX.Element {
  const containerId = useId().replace(/:/g, "-");
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Render the mermaid diagram
  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize(MERMAID_CONFIG);

        const id = `mermaid-${containerId}`;
        const { svg } = await mermaid.render(id, code.trim());

        if (!cancelled) {
          setSvgContent(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to render diagram",
          );
        }
      }
    }

    void renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [code, containerId]);

  // Inject SVG into the inline container
  useEffect(() => {
    if (svgContent && containerRef.current) {
      containerRef.current.innerHTML = svgContent;
    }
  }, [svgContent]);

  const openFullscreen = useCallback(() => setIsFullscreen(true), []);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram--error">
        <div className="mermaid-diagram-error-label">Mermaid diagram error</div>
        <pre className="mermaid-diagram-fallback">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className="mermaid-diagram mermaid-diagram--clickable"
        onClick={openFullscreen}
        title="Click to expand"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openFullscreen();
          }
        }}
      />
      {isFullscreen && svgContent && (
        <MermaidFullscreenOverlay
          svgContent={svgContent}
          onClose={closeFullscreen}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Fullscreen overlay with pan/zoom
// ---------------------------------------------------------------------------

interface FullscreenProps {
  svgContent: string;
  onClose: () => void;
}

function MermaidFullscreenOverlay({
  svgContent,
  onClose,
}: FullscreenProps): React.JSX.Element {
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const panZoomRef = useRef<SvgPanZoom.Instance | null>(null);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useOverlayScope(true);

  // Inject SVG and initialize pan/zoom
  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container) return;

    container.innerHTML = svgContent;
    const svgEl = container.querySelector("svg");
    if (!svgEl) return;

    // Make SVG fill the container for pan/zoom
    svgEl.style.width = "100%";
    svgEl.style.height = "100%";
    svgEl.style.maxWidth = "none";

    let instance: SvgPanZoom.Instance | null = null;

    void import("svg-pan-zoom").then((mod) => {
      const svgPanZoom = mod.default;
      instance = svgPanZoom(svgEl, {
        zoomEnabled: true,
        panEnabled: true,
        controlIconsEnabled: false,
        fit: true,
        center: true,
        minZoom: 0.25,
        maxZoom: 10,
        zoomScaleSensitivity: 0.3,
      });
      panZoomRef.current = instance;
    });

    return () => {
      if (instance) {
        instance.destroy();
        panZoomRef.current = null;
      }
    };
  }, [svgContent]);

  const handleZoomIn = useCallback(() => panZoomRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => panZoomRef.current?.zoomOut(), []);
  const handleReset = useCallback(() => {
    panZoomRef.current?.resetZoom();
    panZoomRef.current?.resetPan();
  }, []);

  return (
    <div
      className="mermaid-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mermaid-overlay-content">
        {/* Toolbar */}
        <div className="mermaid-overlay-toolbar">
          <div className="mermaid-overlay-toolbar-group">
            <button
              className="mermaid-overlay-btn"
              onClick={handleZoomIn}
              title="Zoom in"
            >
              <ZoomInIcon />
            </button>
            <button
              className="mermaid-overlay-btn"
              onClick={handleZoomOut}
              title="Zoom out"
            >
              <ZoomOutIcon />
            </button>
            <button
              className="mermaid-overlay-btn"
              onClick={handleReset}
              title="Reset view"
            >
              <ResetIcon />
            </button>
          </div>
          <button
            className="mermaid-overlay-btn mermaid-overlay-btn--close"
            onClick={onClose}
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </div>

        {/* SVG container with pan/zoom */}
        <div ref={svgContainerRef} className="mermaid-overlay-svg" />

        {/* Hint */}
        <div className="mermaid-overlay-hint">
          Scroll to zoom &middot; Drag to pan &middot; Esc to close
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function ZoomInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 4.5v5M4.5 7h5M11.5 11.5L14 14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 7h5M11.5 11.5L14 14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 2v4h4M14 14v-4h-4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 6A5.5 5.5 0 0 0 3 4.5L2 6M2.5 10a5.5 5.5 0 0 0 10.5 1.5L14 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
