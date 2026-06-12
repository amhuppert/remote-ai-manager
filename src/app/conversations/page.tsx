import ConversationsPage from "@/features/session/ConversationsPage";
import { readConfig } from "@/lib/config/loader";

export default async function Page(): Promise<React.JSX.Element> {
  const config = await readConfig();
  return (
    <ConversationsPage
      defaultModel={config.defaultModel}
      defaultEffort={config.defaultEffort}
    />
  );
}
