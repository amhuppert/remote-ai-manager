"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useDevToolsEnabled } from "@/stores/dev-tools-visibility.store";

const ReactQueryDevtools = dynamic(
  () =>
    import("@tanstack/react-query-devtools").then(
      (m) => m.ReactQueryDevtools,
    ),
  { ssr: false },
);

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 300_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [queryClient] = useState(makeQueryClient);
  const devToolsEnabled = useDevToolsEnabled();

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {devToolsEnabled && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
