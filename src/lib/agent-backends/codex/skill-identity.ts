import path from "node:path";

/** Opaque outside Codex. Repository paths survive equivalent session checkouts. */
export function codexSkillIdentity(
  skillPath: string,
  worktreePath: string,
  home: string,
): string {
  const relative = path.relative(worktreePath, skillPath);
  if (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
    return `skill:repo:${encodeURIComponent(relative)}`;
  const homeRelative = path.relative(home, skillPath);
  if (
    homeRelative !== ".." &&
    !homeRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(homeRelative)
  )
    return `skill:home:${encodeURIComponent(homeRelative)}`;
  return `skill:absolute:${encodeURIComponent(skillPath)}`;
}

export function codexSkillPath(
  identity: string,
  worktreePath: string,
  home: string,
): string | undefined {
  const match = /^skill:(repo|home|absolute):(.+)$/.exec(identity);
  if (!match?.[1] || !match[2]) return undefined;
  const value = decodeURIComponent(match[2]);
  return match[1] === "absolute"
    ? value
    : path.resolve(match[1] === "repo" ? worktreePath : home, value);
}
