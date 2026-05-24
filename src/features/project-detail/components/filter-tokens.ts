export type FilterCategory = "archived" | "status" | "target" | "branch";

export interface FilterToken {
  cat: FilterCategory;
  key: string;
  value: string;
  exclusive?: boolean;
}

export interface FilterState {
  tokens: FilterToken[];
  draft: string;
}

export function tokensToSearchParams(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const token of state.tokens) {
    switch (token.cat) {
      case "archived":
        params.set("archived", token.exclusive ? "only" : "include");
        break;
      case "status":
        params.set("status", token.value);
        break;
      case "target":
        params.set("target", token.value);
        break;
      case "branch":
        params.set("branch", token.value);
        break;
    }
  }
  if (state.draft.length > 0) params.set("q", state.draft);
  return params;
}

export interface ReadableSearchParams {
  get(key: string): string | null;
}

export function searchParamsToTokens(
  params: ReadableSearchParams,
): FilterState {
  const tokens: FilterToken[] = [];

  const archived = params.get("archived");
  if (archived === "include") {
    tokens.push({ cat: "archived", key: "include", value: "include" });
  } else if (archived === "only") {
    tokens.push({
      cat: "archived",
      key: "only",
      value: "only",
      exclusive: true,
    });
  }

  const status = params.get("status");
  if (status !== null && status.length > 0) {
    tokens.push({ cat: "status", key: "is", value: status });
  }

  const target = params.get("target");
  if (target !== null && target.length > 0) {
    tokens.push({ cat: "target", key: "target", value: target });
  }

  const branch = params.get("branch");
  if (branch !== null && branch.length > 0) {
    tokens.push({ cat: "branch", key: "branch", value: branch });
  }

  const draft = params.get("q") ?? "";

  return { tokens, draft };
}
