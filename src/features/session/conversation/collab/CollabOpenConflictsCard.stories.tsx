import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import {
  makeImplementationDisagreement,
  makeObjectiveDisagreement,
  makeOpenConflicts,
  makeUserQuestion,
} from "@/lib/workflows/collaboration/test-fixtures";
import type {
  CollaborationArtifactDisagreement,
  CollaborationUserQuestion,
} from "@/lib/workflows/collaboration/types";
import CollabOpenConflictsCard from "@/features/session/conversation/collab/CollabOpenConflictsCard";

interface AwaitingDemoProps {
  disagreements: CollaborationArtifactDisagreement[];
  questions: CollaborationUserQuestion[];
  drafts: Record<string, string>;
  onDraftChange: (questionId: string, value: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

function AwaitingDemo(props: AwaitingDemoProps): React.JSX.Element {
  return <CollabOpenConflictsCard mode="awaiting" {...props} />;
}

interface AnsweredDemoProps {
  disagreements: CollaborationArtifactDisagreement[];
  questions: CollaborationUserQuestion[];
  submittedAnswers: Record<string, string>;
}

function AnsweredDemo(props: AnsweredDemoProps): React.JSX.Element {
  return <CollabOpenConflictsCard mode="answered" {...props} />;
}

const decorators = [
  (Story: () => React.JSX.Element) => (
    <div style={{ maxWidth: 640, padding: 16 }}>
      <Story />
    </div>
  ),
];

const TWO_QUESTION_FIXTURE = makeOpenConflicts({
  disagreements: [
    makeObjectiveDisagreement(),
    makeImplementationDisagreement(),
  ],
  questions: [
    makeUserQuestion(),
    makeUserQuestion({
      id: "Q-2",
      question:
        "Are we OK with a brief cache miss spike from the warm-up sweep?",
      relatedDisagreementIds: ["D-impl-1"],
    }),
  ],
});

const SINGLE_QUESTION_FIXTURE = makeOpenConflicts();

const awaitingMeta = {
  title: "Collab/CollabOpenConflictsCard/Awaiting",
  component: AwaitingDemo,
  decorators,
} satisfies Meta<typeof AwaitingDemo>;

export default awaitingMeta;
type AwaitingStory = StoryObj<typeof awaitingMeta>;

export const TwoQuestionsEmptyDraftsFromFixture: AwaitingStory = {
  args: {
    disagreements: TWO_QUESTION_FIXTURE.disagreements,
    questions: TWO_QUESTION_FIXTURE.questions,
    drafts: {},
    onDraftChange: fn(),
    onSubmit: fn(),
    isSubmitting: false,
  },
};

export const PartialDraftsControlledFromFixture: AwaitingStory = {
  render: function PartialDraftsControlledFromFixture(args) {
    const [drafts, setDrafts] = useState<Record<string, string>>({
      [TWO_QUESTION_FIXTURE.questions[0]!.id]:
        "Treat the output as a design document.",
    });
    return (
      <AwaitingDemo
        {...args}
        drafts={drafts}
        onDraftChange={(id, value) => {
          setDrafts((prev) => ({ ...prev, [id]: value }));
          args.onDraftChange(id, value);
        }}
      />
    );
  },
  args: {
    disagreements: TWO_QUESTION_FIXTURE.disagreements,
    questions: TWO_QUESTION_FIXTURE.questions,
    drafts: {},
    onDraftChange: fn(),
    onSubmit: fn(),
    isSubmitting: false,
  },
};

export const SubmittingStateFromFixture: AwaitingStory = {
  args: {
    disagreements: SINGLE_QUESTION_FIXTURE.disagreements,
    questions: SINGLE_QUESTION_FIXTURE.questions,
    drafts: {
      [SINGLE_QUESTION_FIXTURE.questions[0]!.id]:
        "Treat the output as a design document.",
    },
    onDraftChange: fn(),
    onSubmit: fn(),
    isSubmitting: true,
  },
};

type AnsweredStory = StoryObj<typeof AnsweredDemo>;

const ANSWERED_FULL_ARGS: AnsweredDemoProps = {
  disagreements: TWO_QUESTION_FIXTURE.disagreements,
  questions: TWO_QUESTION_FIXTURE.questions,
  submittedAnswers: {
    [TWO_QUESTION_FIXTURE.questions[0]!.id]:
      "Treat the output as a design document.",
    [TWO_QUESTION_FIXTURE.questions[1]!.id]:
      "Yes — a brief cache miss spike during warm-up is acceptable.",
  },
};

const ANSWERED_PARTIAL_ARGS: AnsweredDemoProps = {
  disagreements: TWO_QUESTION_FIXTURE.disagreements,
  questions: TWO_QUESTION_FIXTURE.questions,
  submittedAnswers: {
    [TWO_QUESTION_FIXTURE.questions[0]!.id]: "Treat as a design document.",
  },
};

export const AnsweredFromFixture: AnsweredStory = {
  render: () => <AnsweredDemo {...ANSWERED_FULL_ARGS} />,
};

export const AnsweredPartiallyFromFixture: AnsweredStory = {
  render: () => <AnsweredDemo {...ANSWERED_PARTIAL_ARGS} />,
};
