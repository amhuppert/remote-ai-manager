import type { Decorator } from "@storybook/nextjs-vite";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";

/**
 * Storybook decorator that provides a `QueryClient` pre-seeded with the given
 * cache entries. `staleTime: Infinity` keeps seeded data fresh so connected
 * components render it without issuing a (non-existent in Storybook) fetch.
 */
export function withSeededQueryClient(
  entries: Array<[QueryKey, unknown]>,
): Decorator {
  return function SeededQueryClient(Story) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    for (const [key, value] of entries) client.setQueryData(key, value);
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}
