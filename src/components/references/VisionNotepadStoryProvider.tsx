import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NotepadSummaryResolution } from "@/lib/notepads/queries";
import { notepadKeys } from "@/lib/notepads/query-keys";

const storyClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
storyClient.setQueryData<NotepadSummaryResolution>(
  notepadKeys.summary("np-vision"),
  {
    state: "found",
    summary: {
      id: "np-vision",
      name: "Command Center Vision",
      scope: "project",
      revision: 1,
      writeMode: "read-only",
      archived: false,
    },
  },
);

export function VisionNotepadStoryProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <QueryClientProvider client={storyClient}>{children}</QueryClientProvider>
  );
}
