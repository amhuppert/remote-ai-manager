import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import AskQuestionPanel from "./AskQuestionPanel";

const meta = {
  title: "Components/AskQuestionPanel",
  component: AskQuestionPanel,
  args: {
    questionId: "test-question-id-123",
    currentIndex: 0,
    onNavigate: fn(),
    onSubmit: fn(),
    disabled: false,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 700, background: "var(--bg-base)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AskQuestionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleQuestion = {
  args: {
    questions: [
      {
        question: "Which testing framework should I use for this project?",
        header: "Test Framework",
        options: [
          {
            label: "Vitest (Recommended)",
            description:
              "Fast Vite-native test runner with Jest-compatible API",
          },
          {
            label: "Jest",
            description: "Popular, widely adopted testing framework",
          },
          {
            label: "Mocha",
            description: "Flexible, extensible test runner",
          },
        ],
        multiSelect: false,
      },
    ],
  },
} satisfies Story;

export const MultiSelect = {
  args: {
    questions: [
      {
        question: "Which linting rules should I enable?",
        header: "Linting",
        options: [
          {
            label: "no-unused-vars",
            description: "Disallow unused variables",
          },
          {
            label: "no-console",
            description: "Disallow console.log statements",
          },
          {
            label: "prefer-const",
            description: "Require const for never-reassigned variables",
          },
          {
            label: "strict-equality",
            description: "Require === instead of ==",
          },
        ],
        multiSelect: true,
      },
    ],
  },
} satisfies Story;

export const MultipleQuestions = {
  args: {
    questions: [
      {
        question: "Which database should I use?",
        header: "Database",
        options: [
          {
            label: "PostgreSQL (Recommended)",
            description: "Relational, ACID compliant",
          },
          {
            label: "MongoDB",
            description: "Document-oriented, flexible schema",
          },
          { label: "SQLite", description: "Embedded, zero-config" },
        ],
        multiSelect: false,
      },
      {
        question: "Which ORM would you prefer?",
        header: "ORM",
        options: [
          { label: "Prisma", description: "Type-safe, schema-first" },
          { label: "Drizzle", description: "Lightweight, SQL-like" },
          { label: "TypeORM", description: "Decorator-based, mature" },
        ],
        multiSelect: false,
      },
      {
        question: "Which features should the API include?",
        header: "Features",
        options: [
          { label: "Authentication", description: "JWT-based auth" },
          { label: "Rate Limiting", description: "Prevent abuse" },
          { label: "Pagination", description: "Cursor-based pagination" },
          {
            label: "Caching",
            description: "Redis-backed caching layer",
          },
        ],
        multiSelect: true,
      },
    ],
  },
} satisfies Story;

export const NoDescriptions = {
  args: {
    questions: [
      {
        question: "Should I proceed with the refactoring?",
        options: [
          { label: "Yes" },
          { label: "No" },
          { label: "Yes, but only for the core module" },
        ],
        multiSelect: false,
      },
    ],
  },
} satisfies Story;

export const Disabled = {
  args: {
    disabled: true,
    questions: [
      {
        question: "Which approach should I take?",
        header: "Approach",
        options: [
          {
            label: "Approach A",
            description: "Simpler, less flexible",
          },
          {
            label: "Approach B",
            description: "More complex, highly configurable",
          },
        ],
        multiSelect: false,
      },
    ],
  },
} satisfies Story;

export const SecondQuestionActive = {
  args: {
    currentIndex: 1,
    questions: [
      {
        question: "First question?",
        header: "Q1",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
      {
        question: "Second question?",
        header: "Q2",
        options: [
          { label: "X", description: "Option X" },
          { label: "Y", description: "Option Y" },
          { label: "Z", description: "Option Z" },
        ],
        multiSelect: false,
      },
    ],
  },
} satisfies Story;
