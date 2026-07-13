"use client";

import { MessageMarkdown } from "@/components/markdown/Markdown";

const content = `# Per-language prism chunk verification fixture

\`\`\`bash
echo "bash"
\`\`\`

\`\`\`typescript
const x: string = "typescript";
\`\`\`

\`\`\`python
print("python")
\`\`\`

\`\`\`json
{ "key": "json" }
\`\`\`

\`\`\`rust
fn main() { println!("rust"); }
\`\`\`

\`\`\`go
package main
func main() { println("go") }
\`\`\`
`;

export default function PerfFixtureMarkdownPage(): React.JSX.Element {
  return (
    <div
      style={{
        padding: "2rem",
        color: "#e8edf4",
        background: "#0b1019",
        minHeight: "100vh",
      }}
    >
      <MessageMarkdown content={content} />
    </div>
  );
}
