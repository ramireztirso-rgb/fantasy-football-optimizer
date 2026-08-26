/**
 * Hungarian algorithm (Jonker-Volgenant style with potentials), O(n^2 * m).
 *
 * Used for lineup optimization. Greedy slot-filling gets FLEX wrong: filling
 * RB slots with your two best backs can strand a third back who was worth more
 * in FLEX than the receiver you would otherwise put there. Matching solves the
 * whole board at once instead.
 *
 * Minimizes total cost over a rectangular matrix with rows <= cols.
 */

/** Cost used for a forbidden pairing. Large but finite, so potentials stay numeric. */
export const FORBIDDEN = 1e9;

/**
 * @param cost `cost[i][j]` = cost of assigning row i to column j.
 * @returns For each row, the column assigned to it, or -1 if unassigned.
 */
export function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  if (m < n) {
    throw new Error(`minCostAssignment requires cols >= rows (got ${n}x${m})`);
  }

  const INF = Number.POSITIVE_INFINITY;
  // 1-indexed potentials and matching, per the classic formulation.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j] = row matched to column j
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Walk the augmenting path back, flipping the matching as we go.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

/** Convenience wrapper for maximization problems. */
export function maxValueAssignment(value: number[][]): number[] {
  return minCostAssignment(value.map((row) => row.map((x) => -x)));
}
