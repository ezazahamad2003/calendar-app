import type { TaskDep, TaskId } from "./types";

/**
 * Dependency-graph primitives. Pure, no dates involved.
 */

export type DepGraph = {
  /** predecessor → deps flowing out of it. */
  outgoing: ReadonlyMap<TaskId, readonly TaskDep[]>;
  /** successor → deps flowing into it. */
  incoming: ReadonlyMap<TaskId, readonly TaskDep[]>;
  nodes: ReadonlySet<TaskId>;
};

export function buildGraph(deps: readonly TaskDep[]): DepGraph {
  const outgoing = new Map<TaskId, TaskDep[]>();
  const incoming = new Map<TaskId, TaskDep[]>();
  const nodes = new Set<TaskId>();

  for (const dep of deps) {
    nodes.add(dep.predecessorId);
    nodes.add(dep.successorId);

    const out = outgoing.get(dep.predecessorId);
    if (out) out.push(dep);
    else outgoing.set(dep.predecessorId, [dep]);

    const inc = incoming.get(dep.successorId);
    if (inc) inc.push(dep);
    else incoming.set(dep.successorId, [dep]);
  }

  return { outgoing, incoming, nodes };
}

/**
 * Find a dependency cycle, or `null` if the graph is acyclic.
 *
 * Returns the cycle as a closed path — `['a','b','c','a']` — so the caller can
 * name every task in the loop, not just assert that one exists. SPEC §4
 * requires rejecting cycles at write time with a clear error.
 *
 * Iterative DFS with an explicit stack: a deeply chained schedule (a hundred
 * sequential tasks is ordinary on a big job) would blow the call stack on a
 * recursive version.
 */
export function detectCycle(deps: readonly TaskDep[]): TaskId[] | null {
  const { outgoing, nodes } = buildGraph(deps);

  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<TaskId, number>();
  for (const n of nodes) state.set(n, UNVISITED);

  for (const root of nodes) {
    if (state.get(root) !== UNVISITED) continue;

    // path doubles as the DFS stack and as the route back to the cycle start.
    const path: TaskId[] = [];
    const stack: Array<{ node: TaskId; edgeIndex: number }> = [
      { node: root, edgeIndex: 0 },
    ];
    state.set(root, IN_PROGRESS);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = outgoing.get(frame.node) ?? [];

      if (frame.edgeIndex >= edges.length) {
        state.set(frame.node, DONE);
        stack.pop();
        path.pop();
        continue;
      }

      const next = edges[frame.edgeIndex].successorId;
      frame.edgeIndex += 1;

      const nextState = state.get(next) ?? UNVISITED;
      if (nextState === IN_PROGRESS) {
        // Back edge: everything from `next` onward in `path` is the loop.
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (nextState === UNVISITED) {
        state.set(next, IN_PROGRESS);
        path.push(next);
        stack.push({ node: next, edgeIndex: 0 });
      }
    }
  }

  return null;
}

/**
 * Would adding this edge close a loop? Cheaper than rebuilding the whole graph,
 * and the question a write path actually asks.
 */
export function wouldCreateCycle(
  deps: readonly TaskDep[],
  candidate: Pick<TaskDep, "predecessorId" | "successorId">,
): TaskId[] | null {
  if (candidate.predecessorId === candidate.successorId) {
    return [candidate.predecessorId, candidate.predecessorId];
  }
  return detectCycle([
    ...deps,
    { ...candidate, depType: "FS", lagDays: 0 },
  ]);
}

/**
 * Tasks in dependency order — every predecessor before its successors.
 *
 * Kahn's algorithm. Ties break on the caller's original ordering rather than
 * Map iteration order, so a cascade over the same inputs always produces the
 * same diff; an unstable order would make the confirmation screen shuffle
 * between renders for no reason.
 *
 * Throws `CycleError` via `detectCycle` if the graph is cyclic — callers that
 * want to handle that gracefully should check first.
 */
export function topologicalOrder(
  taskIds: readonly TaskId[],
  deps: readonly TaskDep[],
): TaskId[] {
  const { outgoing } = buildGraph(deps);
  const position = new Map<TaskId, number>();
  taskIds.forEach((id, i) => position.set(id, i));

  const indegree = new Map<TaskId, number>();
  for (const id of taskIds) indegree.set(id, 0);
  for (const dep of deps) {
    if (!indegree.has(dep.successorId)) continue;
    indegree.set(dep.successorId, (indegree.get(dep.successorId) ?? 0) + 1);
  }

  const ready = taskIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const sorted: TaskId[] = [];

  while (ready.length > 0) {
    // Smallest original index first — keeps output deterministic.
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const node = ready.shift() as TaskId;
    sorted.push(node);

    for (const dep of outgoing.get(node) ?? []) {
      if (!indegree.has(dep.successorId)) continue;
      const left = (indegree.get(dep.successorId) ?? 0) - 1;
      indegree.set(dep.successorId, left);
      if (left === 0) ready.push(dep.successorId);
    }
  }

  if (sorted.length !== taskIds.length) {
    // Only reachable when the graph is cyclic; surface the actual loop.
    const cycle = detectCycle(deps);
    throw new Error(
      cycle
        ? `Cannot order tasks: ${cycle.join(" → ")} form a dependency loop.`
        : "Cannot order tasks: dependency graph is inconsistent.",
    );
  }

  return sorted;
}
