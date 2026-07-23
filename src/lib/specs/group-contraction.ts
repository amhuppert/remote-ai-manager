export interface ContractableTask {
  id: string;
  handle: string;
  dependsOnTaskIds: readonly string[];
  laneGroup?: string;
}

export interface ContractedTaskGroup {
  id: string;
  laneGroup?: string;
  memberTaskIds: string[];
  orderedTaskIds: string[];
}

export interface ContractedDependencyPair {
  sourceTaskId: string;
  targetTaskId: string;
}

export interface ContractedGroupEdge {
  sourceGroupId: string;
  targetGroupId: string;
  dependencyPairs: ContractedDependencyPair[];
}

export interface GroupContraction {
  groups: ContractedTaskGroup[];
  taskGroupIds: ReadonlyMap<string, string>;
  edges: ContractedGroupEdge[];
  groupCycle?: string[];
  intraGroupCycleTaskIds?: string[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTasks(left: ContractableTask, right: ContractableTask): number {
  return (
    compareText(left.handle, right.handle) || compareText(left.id, right.id)
  );
}

function groupIdForTask(task: ContractableTask): string {
  return task.laneGroup === undefined
    ? `task:${task.id}`
    : `lane:${task.laneGroup}`;
}

export function contractTaskGroups(
  inputTasks: readonly ContractableTask[],
): GroupContraction {
  const tasks = [...inputTasks].sort(compareTasks);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const membersByGroupId = new Map<string, ContractableTask[]>();
  const taskGroupIds = new Map<string, string>();

  for (const task of tasks) {
    const groupId = groupIdForTask(task);
    taskGroupIds.set(task.id, groupId);
    const members = membersByGroupId.get(groupId) ?? [];
    members.push(task);
    membersByGroupId.set(groupId, members);
  }

  const cycleTaskIds = new Set<string>();
  const groups = [...membersByGroupId.entries()]
    .map(([id, members]): ContractedTaskGroup => {
      members.sort(compareTasks);
      const orderedTaskIds = topologicalMemberOrder(
        members,
        tasksById,
        taskGroupIds,
        cycleTaskIds,
      );
      return {
        id,
        ...(members[0]?.laneGroup === undefined
          ? {}
          : { laneGroup: members[0].laneGroup }),
        memberTaskIds: members.map((member) => member.id),
        orderedTaskIds,
      };
    })
    .sort((left, right) => compareGroups(left, right, tasksById));

  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const edgePairs = new Map<string, ContractedDependencyPair[]>();
  for (const targetTask of tasks) {
    const targetGroupId = taskGroupIds.get(targetTask.id);
    if (targetGroupId === undefined) continue;
    for (const sourceTaskId of new Set(targetTask.dependsOnTaskIds)) {
      const sourceGroupId = taskGroupIds.get(sourceTaskId);
      if (sourceGroupId === undefined || sourceGroupId === targetGroupId) {
        continue;
      }
      const key = edgeKey(sourceGroupId, targetGroupId);
      const pairs = edgePairs.get(key) ?? [];
      pairs.push({ sourceTaskId, targetTaskId: targetTask.id });
      edgePairs.set(key, pairs);
    }
  }

  const edges = [...edgePairs.entries()]
    .map(([key, dependencyPairs]): ContractedGroupEdge => {
      const [sourceGroupId, targetGroupId] = parseEdgeKey(key);
      dependencyPairs.sort((left, right) => {
        const leftSource = tasksById.get(left.sourceTaskId);
        const rightSource = tasksById.get(right.sourceTaskId);
        const leftTarget = tasksById.get(left.targetTaskId);
        const rightTarget = tasksById.get(right.targetTaskId);
        return (
          compareOptionalTasks(leftSource, rightSource) ||
          compareOptionalTasks(leftTarget, rightTarget) ||
          compareText(left.sourceTaskId, right.sourceTaskId) ||
          compareText(left.targetTaskId, right.targetTaskId)
        );
      });
      return { sourceGroupId, targetGroupId, dependencyPairs };
    })
    .sort((left, right) => {
      const leftSource = groupsById.get(left.sourceGroupId);
      const rightSource = groupsById.get(right.sourceGroupId);
      const leftTarget = groupsById.get(left.targetGroupId);
      const rightTarget = groupsById.get(right.targetGroupId);
      return (
        compareOptionalGroups(leftSource, rightSource, tasksById) ||
        compareOptionalGroups(leftTarget, rightTarget, tasksById) ||
        compareText(left.sourceGroupId, right.sourceGroupId) ||
        compareText(left.targetGroupId, right.targetGroupId)
      );
    });

  const groupCycle = findGroupCycle(groups, edges, tasksById);
  const intraGroupCycleTaskIds = tasks
    .filter((task) => cycleTaskIds.has(task.id))
    .map((task) => task.id);

  return {
    groups,
    taskGroupIds,
    edges,
    ...(groupCycle === undefined ? {} : { groupCycle }),
    ...(intraGroupCycleTaskIds.length === 0 ? {} : { intraGroupCycleTaskIds }),
  };
}

export function contractedGroupsHavePath(
  contraction: Pick<GroupContraction, "edges">,
  sourceGroupId: string,
  targetGroupId: string,
): boolean {
  if (sourceGroupId === targetGroupId) return false;
  const targetsBySource = new Map<string, string[]>();
  for (const edge of contraction.edges) {
    const targets = targetsBySource.get(edge.sourceGroupId) ?? [];
    targets.push(edge.targetGroupId);
    targetsBySource.set(edge.sourceGroupId, targets);
  }

  const pending = [...(targetsBySource.get(sourceGroupId) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || visited.has(current)) continue;
    if (current === targetGroupId) return true;
    visited.add(current);
    pending.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
}

function topologicalMemberOrder(
  members: readonly ContractableTask[],
  tasksById: ReadonlyMap<string, ContractableTask>,
  taskGroupIds: ReadonlyMap<string, string>,
  cycleTaskIds: Set<string>,
): string[] {
  const memberIds = new Set(members.map((member) => member.id));
  const inDegree = new Map(members.map((member) => [member.id, 0]));
  const dependents = new Map<string, Set<string>>();

  for (const member of members) {
    for (const dependencyId of new Set(member.dependsOnTaskIds)) {
      if (
        !memberIds.has(dependencyId) ||
        taskGroupIds.get(dependencyId) !== taskGroupIds.get(member.id)
      ) {
        continue;
      }
      inDegree.set(member.id, (inDegree.get(member.id) ?? 0) + 1);
      const targets = dependents.get(dependencyId) ?? new Set<string>();
      targets.add(member.id);
      dependents.set(dependencyId, targets);
    }
  }

  const ready = members.filter((member) => inDegree.get(member.id) === 0);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareTasks);
    const current = ready.shift();
    if (current === undefined) continue;
    ordered.push(current.id);
    for (const dependentId of dependents.get(current.id) ?? []) {
      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        const dependent = tasksById.get(dependentId);
        if (dependent !== undefined) ready.push(dependent);
      }
    }
  }

  if (ordered.length === members.length) return ordered;
  for (const member of members) {
    if (ordered.includes(member.id)) continue;
    cycleTaskIds.add(member.id);
    ordered.push(member.id);
  }
  return ordered;
}

function findGroupCycle(
  groups: readonly ContractedTaskGroup[],
  edges: readonly ContractedGroupEdge[],
  tasksById: ReadonlyMap<string, ContractableTask>,
): string[] | undefined {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.sourceGroupId) ?? [];
    targets.push(edge.targetGroupId);
    targetsBySource.set(edge.sourceGroupId, targets);
  }
  for (const targets of targetsBySource.values()) {
    targets.sort((left, right) =>
      compareOptionalGroups(
        groupsById.get(left),
        groupsById.get(right),
        tasksById,
      ),
    );
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  let found: string[] | undefined;
  const visit = (groupId: string): void => {
    if (found !== undefined) return;
    state.set(groupId, "visiting");
    stack.push(groupId);
    for (const targetId of targetsBySource.get(groupId) ?? []) {
      if (state.get(targetId) === "visited") continue;
      if (state.get(targetId) === "visiting") {
        const start = stack.indexOf(targetId);
        found = [...stack.slice(start), targetId];
        return;
      }
      visit(targetId);
      if (found !== undefined) return;
    }
    stack.pop();
    state.set(groupId, "visited");
  };

  for (const group of groups) {
    if (state.has(group.id)) continue;
    visit(group.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function compareGroups(
  left: ContractedTaskGroup,
  right: ContractedTaskGroup,
  tasksById: ReadonlyMap<string, ContractableTask>,
): number {
  return (
    compareOptionalTasks(
      tasksById.get(left.memberTaskIds[0] ?? ""),
      tasksById.get(right.memberTaskIds[0] ?? ""),
    ) || compareText(left.id, right.id)
  );
}

function compareOptionalTasks(
  left: ContractableTask | undefined,
  right: ContractableTask | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return compareTasks(left, right);
}

function compareOptionalGroups(
  left: ContractedTaskGroup | undefined,
  right: ContractedTaskGroup | undefined,
  tasksById: ReadonlyMap<string, ContractableTask>,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return compareGroups(left, right, tasksById);
}

function edgeKey(sourceGroupId: string, targetGroupId: string): string {
  return JSON.stringify([sourceGroupId, targetGroupId]);
}

function parseEdgeKey(key: string): [string, string] {
  const parsed: unknown = JSON.parse(key);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("Invalid contracted group edge key.");
  }
  return [parsed[0], parsed[1]];
}
