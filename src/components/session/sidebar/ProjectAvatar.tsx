import { cn } from "@/lib/ui/cn";
import { projectIdentity } from "./project-identity";

const PROJECT_COLORS = [
  "bg-cyan-dim",
  "bg-amber",
  "bg-green-dim",
  "bg-blue",
] as const;

export default function ProjectAvatar({
  projectName,
  size = "md",
}: {
  projectName: string;
  size?: "sm" | "md";
}) {
  const { initials, colorIndex } = projectIdentity(projectName);
  return (
    <span
      aria-hidden="true"
      title={projectName}
      data-project-avatar={projectName}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-mono font-bold leading-none text-text-inverse",
        size === "sm"
          ? "size-[24px] text-[0.8rem]"
          : "size-[36px] text-[1.05rem]",
        PROJECT_COLORS[colorIndex],
      )}
    >
      {initials}
    </span>
  );
}
