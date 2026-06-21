// Browser stub for `mermaid`, used ONLY by the /design-sync bundle.
//
// Mermaid plus its d3 / dagre / cytoscape / katex subtree is ~5 MB minified and
// pushes _ds_bundle.js past the 5 MB upload cap. It is reached only when
// MarkdownContent renders a ```mermaid fenced block, via MermaidDiagram's dynamic
// `import("mermaid")` → `.initialize()` then `.render(id, code)`. The stub renders
// a labeled placeholder box so a mermaid block in a synced design degrades
// gracefully instead of shipping the whole diagram engine. The real `mermaid` is
// untouched in the app — this alias exists only in .design-sync/tsconfig.bundle.json.

interface RenderResult {
  svg: string;
}

function placeholderSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" role="img" aria-label="mermaid diagram placeholder">',
    '<rect x="1" y="1" width="318" height="118" rx="8" fill="none" stroke="#00e5ff" stroke-opacity="0.5" stroke-dasharray="5 4"/>',
    '<text x="160" y="60" fill="#e0e0e0" font-family="ui-monospace, monospace" font-size="13" text-anchor="middle" dominant-baseline="middle">mermaid diagram</text>',
    "</svg>",
  ].join("");
}

const mermaid = {
  initialize(_config: unknown): void {},
  async render(_id: string, _code: string): Promise<RenderResult> {
    return { svg: placeholderSvg() };
  },
};

export default mermaid;
