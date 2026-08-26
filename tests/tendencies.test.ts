import { describe, expect, it } from "vitest";
import { analyzeDraftTendencies, type HistoricalDraft, type PlayerReference } from "@/lib/engine/tendencies";
import { normalizeDraftSettings, normalizeDraftStatus } from "@/lib/espn/normalize";
import { buildDemoPlayers } from "@/lib/demo/league";
import type { DraftPick, Position } from "@/lib/domain/types";

function pick(overall: number, teamId: number, playerId: number, keeper = false): DraftPick {
  return {
    overallPick: overall,
    round: Math.floor((overall - 1) / 12) + 1,
    roundPick: ((overall - 1) % 12) + 1,
    teamId,
    playerId,
    keeper,
  };
}

describe("draft detail normalization", () => {
  it("reads settings, order, and rounds from the raw payload", () => {
    const settings = normalizeDraftSettings({
      settings: {
        draftSettings: { type: "SNAKE", pickOrder: [4, 1, 3, 2], keeperCount: 2, timePerSelection: 60 },
        rosterSettings: { lineupSlotCounts: { "0": 1, "2": 2, "4": 3, "20": 7, "21": 1 } },
      },
    });
    expect(settings.type).toBe("SNAKE");
    expect(settings.pickOrder).toEqual([4, 1, 3, 2]);
    // Rounds equal the seats the draft fills: bench included, IR excluded.
    expect(settings.rounds).toBe(13);
    expect(settings.keeperCount).toBe(2);
  });

  it("marks an unrecognized draft type rather than guessing", () => {
    expect(normalizeDraftSettings({ settings: { draftSettings: { type: "WEIRD" } } }).type).toBe("UNKNOWN");
    expect(normalizeDraftSettings({}).type).toBe("UNKNOWN");
  });

  it("sorts picks and derives missing pick numbers", () => {
    const status = normalizeDraftStatus(
      {
        drafted: false,
        inProgress: true,
        picks: [
          { playerId: 20, teamId: 2, overallPickNumber: 2 },
          { playerId: 10, teamId: 1, overallPickNumber: 1, roundId: 1, roundPickNumber: 1 },
          // Keepers sometimes arrive with no pick number at all.
          { playerId: 30, teamId: 3, keeper: true },
        ],
      },
      normalizeDraftSettings({}),
      12,
    );
    expect(status.inProgress).toBe(true);
    expect(status.picks.map((p) => p.overallPick)).toEqual([1, 2, 3]);
    expect(status.picks[2].keeper).toBe(true);
  });

  it("drops malformed picks rather than failing the draft", () => {
    const status = normalizeDraftStatus(
      { picks: [{ playerId: 1 }, { teamId: 2 }, { playerId: 3, teamId: 3 }] },
      normalizeDraftSettings({}),
      12,
    );
    expect(status.picks).toHaveLength(1);
  });

  it("treats a missing draftDetail as an empty draft", () => {
    const status = normalizeDraftStatus(undefined, normalizeDraftSettings({}), 12);
    expect(status.picks).toEqual([]);
    expect(status.completed).toBe(false);
  });
});

describe("league draft tendencies", () => {
  // A league that reaches badly for quarterbacks and lets tight ends slide.
  const info = new Map<number, PlayerReference>();
  const drafts: HistoricalDraft[] = [];

  for (const season of [2024, 2025]) {
    const picks: DraftPick[] = [];
    let overall = 1;
    for (let round = 1; round <= 3; round++) {
      for (let team = 1; team <= 12; team++) {
        const playerId = season * 1000 + overall;
        // Four teams reliably take a QB early; the rest go RB/WR.
        const position: Position = team <= 4 && round <= 2 ? "QB" : round === 1 ? "RB" : "WR";
        info.set(playerId, {
          position,
          // QBs go ~30 picks earlier here than the market takes them.
          averageDraftPosition: position === "QB" ? overall + 30 : overall + 1,
          adpSeason: season,
        });
        picks.push(pick(overall, team, playerId));
        overall++;
      }
    }
    drafts.push({ seasonId: season, picks });
  }

  const names = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, `Team ${i + 1}`] as const));
  // A market baseline where the early rounds are almost entirely RB/WR.
  const marketOrder: Position[] = Array.from({ length: 72 }, (_, i) =>
    i % 12 === 0 ? "TE" : i % 2 === 0 ? "RB" : "WR",
  );
  const result = analyzeDraftTendencies(drafts, info, names, marketOrder);

  it("reports the seasons and coverage it actually used", () => {
    expect(result.seasonsAnalyzed).toEqual([2024, 2025]);
    expect(result.coverage).toBe(1);
    expect(result.totalPicks).toBe(72);
  });

  it("detects that the league reaches for quarterbacks", () => {
    const qb = result.positions.find((p) => p.position === "QB")!;
    expect(qb.reachPicks).toBeGreaterThan(8);
    // The market spends none of its early picks on QB; this league spends many.
    expect(qb.earlyBias).toBeGreaterThan(0.06);
    expect(result.insights.join(" ")).toMatch(/more of its early picks on QB/);
  });

  it("uses same-season ADP only", () => {
    expect(result.adpComparable).toBe(true);

    // Same picks, but the ADP now describes a different year. Comparing a 2024
    // pick to a 2026 ADP measures the player's career arc, not the league.
    const wrongYear = new Map(
      [...info].map(([id, ref]) => [id, { ...ref, adpSeason: 2099 }] as const),
    );
    const r = analyzeDraftTendencies(drafts, wrongYear, names, marketOrder);
    expect(r.adpComparable).toBe(false);
    for (const p of r.positions) {
      expect(p.reachPicks).toBeNull();
      expect(p.nationalMeanAdp).toBeNull();
    }
    // The year-robust early-mix signal must still survive.
    expect(r.positions.find((p) => p.position === "QB")!.earlyBias).toBeGreaterThan(0.06);
    expect(r.insights.join(" ")).toMatch(/Same-season ADP was not available/);
  });

  it("ignores ADP with no season attached at all", () => {
    const noSeason = new Map(
      [...info].map(([id, ref]) => [id, { position: ref.position, averageDraftPosition: 5 }] as const),
    );
    const r = analyzeDraftTendencies(drafts, noSeason, names, marketOrder);
    expect(r.adpComparable).toBe(false);
  });

  it("reports no early bias without a market baseline", () => {
    const r = analyzeDraftTendencies(drafts, info, names, []);
    for (const p of r.positions) {
      expect(p.marketEarlyShare).toBeNull();
      expect(p.earlyBias).toBeNull();
    }
  });

  it("labels the managers who consistently take a QB early", () => {
    const early = result.managers.filter((m) => m.label === "Takes a QB early");
    expect(early.length).toBe(4);
    expect(result.insights.join(" ")).toMatch(/take a quarterback in the first three rounds/);
  });

  it("excludes keepers, which are not draft decisions", () => {
    const withKeepers: HistoricalDraft[] = [
      { seasonId: 2025, picks: [pick(1, 1, 1, true), pick(2, 2, 2, false)] },
    ];
    const keeperInfo = new Map<number, PlayerReference>([
      [1, { position: "RB" }],
      [2, { position: "WR" }],
    ]);
    const r = analyzeDraftTendencies(withKeepers, keeperInfo, names, marketOrder);
    expect(r.totalPicks).toBe(1);
  });

  it("says so plainly when there is no history", () => {
    const r = analyzeDraftTendencies([], new Map(), names, marketOrder);
    expect(r.insights[0]).toMatch(/No completed drafts/);
    expect(r.positions).toEqual([]);
  });

  it("warns that a single draft is not a pattern", () => {
    const r = analyzeDraftTendencies([drafts[0]], info, names, marketOrder);
    expect(r.insights[0]).toMatch(/single draft/);
  });

  it("reports partial coverage honestly", () => {
    const partial = new Map([...info].slice(0, 20));
    const r = analyzeDraftTendencies(drafts, partial, names, marketOrder);
    expect(r.coverage).toBeLessThan(1);
    expect(r.coverage).toBeGreaterThan(0);
  });
});

describe("demo pool ADP", () => {
  // ADP was assigned by generation order, so every quarterback landed at the
  // top of the board purely because QBs are generated first.
  it("does not front-load the board with quarterbacks", () => {
    const players = buildDemoPlayers();
    const top36 = [...players]
      .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition)
      .slice(0, 36);
    const qbShare = top36.filter((p) => p.position === "QB").length / top36.length;
    expect(qbShare).toBeLessThan(0.25);
    expect(top36.some((p) => p.position === "RB")).toBe(true);
    expect(top36.some((p) => p.position === "WR")).toBe(true);
  });

  it("keeps kickers and defenses off the early board", () => {
    const players = buildDemoPlayers();
    const top50 = [...players]
      .sort((a, b) => a.averageDraftPosition - b.averageDraftPosition)
      .slice(0, 50);
    expect(top50.some((p) => p.position === "K" || p.position === "DST")).toBe(false);
  });

  it("gives every player a usable ADP", () => {
    for (const p of buildDemoPlayers()) {
      expect(p.averageDraftPosition).toBeGreaterThan(0);
      expect(Number.isFinite(p.averageDraftPosition)).toBe(true);
    }
  });
});
