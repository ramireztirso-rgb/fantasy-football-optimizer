import { describe, expect, it } from "vitest";
import { FORBIDDEN, maxValueAssignment, minCostAssignment } from "@/lib/engine/assignment";

describe("minCostAssignment", () => {
  it("finds the optimal assignment on a square matrix", () => {
    // Optimal is 1->0 (1), 0->1 (2), 2->2 (3) = 6; the greedy row-by-row
    // choice would take 0->0 (4) first and end up worse.
    const cost = [
      [4, 2, 8],
      [1, 9, 9],
      [9, 9, 3],
    ];
    const assignment = minCostAssignment(cost);
    const total = assignment.reduce((sum, col, row) => sum + cost[row][col], 0);
    expect(total).toBe(6);
  });

  it("handles more columns than rows", () => {
    const cost = [
      [5, 1, 9, 9],
      [9, 9, 2, 8],
    ];
    const assignment = minCostAssignment(cost);
    expect(assignment).toHaveLength(2);
    const total = assignment.reduce((sum, col, row) => sum + cost[row][col], 0);
    expect(total).toBe(3);
  });

  it("rejects matrices with fewer columns than rows", () => {
    expect(() => minCostAssignment([[1, 2], [3, 4], [5, 6]])).toThrow(/cols >= rows/);
  });

  it("returns an empty assignment for an empty matrix", () => {
    expect(minCostAssignment([])).toEqual([]);
  });

  it("beats greedy when a shared slot is contested", () => {
    // Rows are slots, columns players. Greedy fills row 0 with the globally
    // best player and strands row 1 with a bad one.
    const value = [
      [10, 9, 0],
      [10, 0, 0],
      [0, 0, 4],
    ];
    const assignment = maxValueAssignment(value);
    const total = assignment.reduce((sum, col, row) => sum + value[row][col], 0);
    expect(total).toBe(23); // 9 + 10 + 4, not 10 + 0 + 4
  });

  it("leaves a row unassigned rather than taking a forbidden pairing", () => {
    const cost = [
      [1, FORBIDDEN],
      [FORBIDDEN, FORBIDDEN],
    ];
    const assignment = minCostAssignment(cost);
    expect(assignment[0]).toBe(0);
    // Row 1 has no legal column, so whatever it is matched to is forbidden and
    // callers are expected to treat that as "slot stays empty".
    expect(cost[1][assignment[1]]).toBe(FORBIDDEN);
  });
});
