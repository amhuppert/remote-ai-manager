import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MarkdownViewer from "./MarkdownViewer";

const meta = {
  title: "Components/MarkdownViewer",
  component: MarkdownViewer,
} satisfies Meta<typeof MarkdownViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

const richMarkdown = `# Focus Document

## Session Objective

The agent is tasked with implementing a **dark mode toggle** for the application settings page.

### Key Requirements

1. Add a toggle switch to the settings page
2. Store the preference in localStorage
3. Apply the theme globally using CSS custom properties
4. Support system preference detection via \`prefers-color-scheme\`

### Technical Approach

The implementation uses a \`ThemeProvider\` context that wraps the application root:

\`\`\`typescript
interface ThemeContext {
  theme: "light" | "dark" | "system";
  setTheme: (theme: Theme) => void;
}
\`\`\`

> **Note:** The system preference is detected on mount and updated via a media query listener.

### Files to Modify

| File | Changes |
|------|---------|
| \`src/components/ThemeProvider.tsx\` | New component |
| \`src/app/layout.tsx\` | Wrap with provider |
| \`src/app/settings/page.tsx\` | Add toggle UI |
| \`src/app/globals.css\` | Dark mode tokens |

### Progress

- [x] Analyzed existing codebase
- [x] Identified color token locations
- [ ] Implement ThemeProvider
- [ ] Add settings toggle
- [ ] Test cross-browser

---

*Last updated: 2 minutes ago*
`;

export const WithContent: Story = {
  args: {
    content: richMarkdown,
    isLoading: false,
  },
};

export const Loading: Story = {
  args: {
    content: null,
    isLoading: true,
  },
};

export const Empty: Story = {
  args: {
    content: null,
    isLoading: false,
    emptyMessage:
      "Focus document not yet available. It will appear once the agent has analyzed the session objective.",
  },
};

const longMarkdown = Array.from(
  { length: 20 },
  (_, i) =>
    `## Section ${i + 1}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.\n\n- Item one with some detail\n- Item two with more explanation\n- Item three wrapping up\n`,
).join("\n");

export const LongContent: Story = {
  args: {
    content: longMarkdown,
    isLoading: false,
  },
  decorators: [
    (Story) => (
      <div style={{ height: 500, display: "flex", flexDirection: "column" }}>
        <Story />
      </div>
    ),
  ],
};
