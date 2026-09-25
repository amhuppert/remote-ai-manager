"use client";

import { useRef } from "react";

import { CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";

import {
  MEMORY_INDEX_MODE_ORDER,
  MEMORY_INDEX_MODES,
} from "./memory-index-mode";

/**
 * When to reach for each inclusion mode. The shared mode description comes
 * first so the modal and the editor's radio group cannot describe a mode two
 * ways.
 */
const MODE_ADVICE = {
  always:
    "Use it sparingly for knowledge that matters across tasks, such as a recurring trap.",
  auto: "Use it for most durable lessons, preferences, and procedures.",
  "search-only":
    "Use it for detailed reference material that is useful on demand.",
} as const;

/**
 * On-demand explanation of the memory system. It owns its trigger and reads
 * nothing, so opening it never disturbs a draft, a filter, or the preview
 * subject beneath it.
 */
export default function MemoryHelpDialog(): React.JSX.Element {
  const titleRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" touch>
          How memory works
        </Button>
      </DialogTrigger>
      <DialogContent
        size="wide"
        mobileSheet="full-height"
        // A long explanation should open at its top, not scrolled to whichever
        // control Radix would focus first.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <div className="flex max-h-[calc(100dvh-8rem)] min-h-0 flex-col max-768:h-full max-768:max-h-none">
          <div className="flex shrink-0 items-start gap-md">
            {/* The initial focus target: programmatic focus on the heading
                itself would paint a focus ring around the title. */}
            <div
              ref={titleRef}
              tabIndex={-1}
              className="min-w-0 flex-1 outline-none"
            >
              <DialogTitle>How memory works</DialogTitle>
            </div>
            <WithTooltip label="Close memory help">
              <DialogClose asChild>
                <IconButton aria-label="Close memory help">
                  <CloseIcon />
                </IconButton>
              </DialogClose>
            </WithTooltip>
          </div>
          <DialogDescription layoutClassName="shrink-0">
            Command Center memory keeps useful knowledge available across
            conversations and agent backends. Agents can save and retrieve
            notes; this library lets you inspect, edit, and review them.
            Memories are reference material: current code, instructions, and
            live project state remain the source of truth.
          </DialogDescription>

          {/* Focusable so the explanation can be scrolled from the keyboard;
              it holds no controls of its own to take focus. */}
          <div
            role="region"
            aria-label="Memory help"
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto border-0 border-t border-solid border-border-subtle pt-lg pr-xs font-mono text-[0.78rem] leading-[1.6] text-text-secondary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            <HelpSection title="What agents receive">
              <p className={PARAGRAPH}>
                Agents receive a compact index of eligible memories, not the
                full contents of every note. A note&apos;s <Term>hook</Term> is
                the short, standalone fact shown in the index. Its{" "}
                <Term>body</Term> holds the explanation, evidence, or commands
                an agent can read when needed. An optional{" "}
                <Term>status note</Term> holds temporary context and has its own
                review deadline.
              </p>
              <p className={PARAGRAPH}>
                A conversation&apos;s first memory delivery is a full index.
                Later turns can receive only changes. The index has a size
                budget, so a note can be saved in the library without appearing
                in it. Agents can search for additional notes and open them
                directly.
              </p>
            </HelpSection>

            <HelpSection title="Where a memory applies">
              <dl className={DEFINITIONS}>
                <Definition term="Global">
                  Available across projects.
                </Definition>
                <Definition term="Project">
                  Available within one project, including its sessions.
                </Definition>
                <Definition term="Session">
                  Available within the session it belongs to.
                </Definition>
              </dl>
              <p className={PARAGRAPH}>
                Scope determines where a memory is available. Kind—lesson,
                procedure, preference, or state—describes its content. Index
                inclusion is a separate setting.
              </p>
            </HelpSection>

            <HelpSection title="Choose index inclusion">
              <dl className={DEFINITIONS}>
                {MEMORY_INDEX_MODE_ORDER.map((mode) => (
                  <Definition key={mode} term={MEMORY_INDEX_MODES[mode].label}>
                    {MEMORY_INDEX_MODES[mode].description} {MODE_ADVICE[mode]}
                  </Definition>
                ))}
              </dl>
              <p className={PARAGRAPH}>
                Always does not bypass scope, review deadlines, expiry, or a
                conversation&apos;s memory policy. Notes linked to the artifact
                a conversation is working on and notes from its own session can
                take priority. A Search-only note stays out of the index even
                when linked to an artifact.
              </p>
            </HelpSection>

            <HelpSection title="Keep memories useful">
              <p className={PARAGRAPH}>
                Use the hook for a durable fact that makes sense on its own, the
                body for supporting detail, and the status note for temporary
                context. Prefer knowledge that is hard to rediscover over
                information already clear in the code or project instructions.
              </p>
              <p className={PARAGRAPH}>
                <Term>Review due</Term> means a note or its status note needs
                checking. An overdue note is withheld from automatic delivery;
                an overdue status note withholds only that status line. Expired
                notes are also withheld. These notes remain available through
                search and direct lookup. Mark a note or status reviewed only
                after checking that it is still accurate.
              </p>
              <p className={PARAGRAPH}>
                <Term>Proposed</Term> global notes written by agents need
                approval before becoming active.{" "}
                <Term>Promotion candidates</Term> are notes from completed
                sessions that may be worth keeping at project scope; promotion
                creates a project note and replaces the session note.
              </p>
            </HelpSection>

            <HelpSection title="Editing and removal">
              <p className={PARAGRAPH}>
                Change the content or index inclusion, then select{" "}
                <Term>Save note</Term>. <Term>Revert</Term> discards your
                unsaved edits. If another writer changed the note while you were
                editing, the save is refused so you can review the newer version
                before trying again.
              </p>
              <p className={PARAGRAPH}>
                <Term>Archive</Term> removes a note from active use while
                retaining its history. <Term>Supersede</Term> replaces it with a
                new note. <Term>Delete</Term> permanently removes the note and
                its revision history and requires confirmation. History lets you
                restore an earlier revision as a new revision.
              </p>
            </HelpSection>

            <HelpSection title="Inspect a conversation's index">
              <p className={PARAGRAPH}>
                Open <Term>Index preview</Term>, choose a project and
                conversation, then select <Term>Next turn</Term> or{" "}
                <Term>Full index</Term>. Next turn shows the memory block due
                from the conversation&apos;s current state; Full index shows the
                complete budgeted index for that conversation. A turn started
                with different runtime settings can receive a different block.
              </p>
              <p className={PARAGRAPH}>
                Changing a note affects future memory delivery; it does not
                rewrite messages an agent has already received. This library
                manages Command Center memory. Provider-specific memory that
                remains enabled is separate; the screen displays a notice when
                Command Center cannot disable it.
              </p>
            </HelpSection>
          </div>

          <div className="flex shrink-0 justify-end border-0 border-t border-solid border-border-subtle pt-md">
            <DialogClose asChild>
              <Button variant="default" touch>
                Close
              </Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const PARAGRAPH = "m-0";
const DEFINITIONS = "m-0 flex flex-col gap-sm";

function HelpSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-sm">
      <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Definition({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2xs">
      <dt className="font-semibold text-text-primary">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <strong className="font-semibold text-text-primary">{children}</strong>
  );
}
