import type { DraftStatus, League, Player, Position, RosterSlot, Team } from "@/lib/domain/types";

/**
 * Deterministic synthetic league.
 *
 * Two jobs: it lets the UI be driven end-to-end before ESPN cookies are wired
 * up, and it gives the engine tests a realistic fixture without pinning them to
 * a recorded ESPN payload that goes stale every season.
 *
 * Deliberately seeded and pure -- the same call always produces the same
 * league, so a failing test is reproducible.
 */

/** Mulberry32: small, fast, and repeatable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS = ["KC", "BUF", "PHI", "SF", "DAL", "MIA", "BAL", "DET", "CIN", "LAR", "GB", "MIN", "HOU", "NYJ", "SEA", "JAX"];
const FIRST = ["Marcus", "Tyler", "Jalen", "Devon", "Chris", "Aaron", "Brandon", "Isaiah", "Trey", "Kenny", "Rashad", "Malik", "Deion", "Cooper", "Amari", "Zay", "Elijah", "Javon"];
const LAST = ["Carter", "Bell", "Hayes", "Brooks", "Wallace", "Freeman", "Sutton", "Nowak", "Reyes", "Okafor", "Lindgren", "Vance", "Dorsey", "Pham", "Achebe", "Rivera", "Kowalski", "Nakamura"];

const POSITION_MIX: Array<{ pos: Position; count: number; topPPG: number }> = [
  { pos: "QB", count: 32, topPPG: 24 },
  { pos: "RB", count: 64, topPPG: 21 },
  { pos: "WR", count: 80, topPPG: 20 },
  { pos: "TE", count: 32, topPPG: 15 },
  { pos: "K", count: 20, topPPG: 10 },
  { pos: "DST", count: 20, topPPG: 11 },
];

export interface DemoOptions {
  seed?: number;
  teamCount?: number;
  week?: number;
}

export function buildDemoPlayers(opts: DemoOptions = {}): Player[] {
  const rand = rng(opts.seed ?? 20260825);
  const week = opts.week ?? 6;
  const players: Player[] = [];
  let id = 1000;

  for (const { pos, count, topPPG } of POSITION_MIX) {
    for (let i = 0; i < count; i++) {
      // Talent decays roughly exponentially down a position's depth chart.
      const decay = Math.exp(-i / (count * 0.35));
      const ppg = Math.max(1.5, topPPG * decay * (0.85 + rand() * 0.3));
      const proTeam = TEAMS[Math.floor(rand() * TEAMS.length)];
      const byeWeek = 5 + Math.floor(rand() * 9);

      const gameLog = [];
      for (let w = 1; w < week; w++) {
        if (w === byeWeek) continue;
        const noise = 0.35 + rand() * 1.3;
        gameLog.push({ week: w, points: round2(ppg * noise), raw: {}, applied: {} });
      }

      const seasonPoints = round2(gameLog.reduce((s, g) => s + g.points, 0));
      const injuryRoll = rand();
      const injuryStatus =
        injuryRoll > 0.965 ? "OUT" : injuryRoll > 0.92 ? "QUESTIONABLE" : undefined;

      players.push({
        id: id++,
        name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
        position: pos,
        proTeam,
        eligibleSlots: eligibleSlotsFor(pos),
        injuryStatus,
        byeWeek,
        percentOwned: round2(Math.min(99.8, 100 * decay + rand() * 8)),
        percentOwnedDelta: round2((rand() - 0.55) * 22),
        percentStarted: round2(Math.min(99, 92 * decay)),
        projectedPoints: round2(ppg * (0.9 + rand() * 0.2)),
        seasonProjectedPoints: round2(ppg * 17),
        gameLog,
        seasonPoints,
        // Assigned below, once the whole pool exists and can be ranked across
        // positions. Ranking by generation order would make every quarterback
        // an early pick purely because QBs are generated first.
        averageDraftPosition: 0,
        draftRank: i + 1,
      });
    }
  }

  assignDemoAdp(players, rng((opts.seed ?? 20260825) + 313));
  return players;
}

/**
 * Assigns a plausible ADP across the whole pool.
 *
 * Real drafters do not rank by raw projected points -- quarterbacks outscore
 * everyone and still go late, because only one starts. The positional weights
 * below reproduce that, so the pool's ADP ordering resembles a real board.
 */
function assignDemoAdp(players: Player[], rand: () => number): void {
  const draftWeight: Record<Position, number> = {
    RB: 1,
    WR: 0.97,
    TE: 0.82,
    QB: 0.55,
    K: 0.12,
    DST: 0.14,
  };

  const ranked = [...players].sort(
    (a, b) =>
      b.seasonProjectedPoints * draftWeight[b.position] -
      a.seasonProjectedPoints * draftWeight[a.position],
  );
  ranked.forEach((player, index) => {
    // A little noise so ADP is not a perfect ordering of the board.
    player.averageDraftPosition = round2(Math.max(1, index + 1 + (rand() - 0.5) * 8));
  });
}

function eligibleSlotsFor(pos: Position): string[] {
  switch (pos) {
    case "RB":
      return ["RB", "RB/WR", "FLEX", "OP", "BE", "IR"];
    case "WR":
      return ["WR", "RB/WR", "WR/TE", "FLEX", "OP", "BE", "IR"];
    case "TE":
      return ["TE", "WR/TE", "FLEX", "OP", "BE", "IR"];
    case "QB":
      return ["QB", "TQB", "OP", "BE", "IR"];
    case "K":
      return ["K", "BE"];
    case "DST":
      return ["DST", "BE"];
  }
}

/**
 * A partially completed demo draft, so the live-draft view has something real
 * to render before anyone connects a league. Picks follow snake order and
 * roughly plausible positional preferences.
 */
export function buildDemoDraft(opts: DemoOptions = {}): DraftStatus {
  const teamCount = opts.teamCount ?? 12;
  const rand = rng((opts.seed ?? 20260825) + 91);
  const players = buildDemoPlayers(opts);
  const pickOrder = Array.from({ length: teamCount }, (_, i) => i + 1);

  const byPos = new Map<Position, Player[]>();
  for (const p of players) {
    const list = byPos.get(p.position) ?? [];
    list.push(p);
    byPos.set(p.position, list);
  }
  for (const list of byPos.values()) {
    list.sort((a, b) => b.seasonProjectedPoints - a.seasonProjectedPoints);
  }

  const cursors: Record<string, number> = {};
  const picks = [];
  const picksMade = teamCount * 3 + 4; // partway through round four

  for (let overall = 1; overall <= picksMade; overall++) {
    const round = Math.floor((overall - 1) / teamCount) + 1;
    const indexInRound = (overall - 1) % teamCount;
    const seat = round % 2 === 1 ? indexInRound : teamCount - 1 - indexInRound;
    const teamId = pickOrder[seat];

    // Early rounds skew RB/WR, with the occasional QB or TE reach.
    const roll = rand();
    const pos: Position =
      round <= 2
        ? roll < 0.45
          ? "RB"
          : roll < 0.85
            ? "WR"
            : roll < 0.94
              ? "TE"
              : "QB"
        : roll < 0.35
          ? "RB"
          : roll < 0.7
            ? "WR"
            : roll < 0.85
              ? "QB"
              : "TE";

    const pool = byPos.get(pos) ?? [];
    const idx = cursors[pos] ?? 0;
    const player = pool[idx];
    cursors[pos] = idx + 1;
    if (!player) continue;

    picks.push({
      overallPick: overall,
      round,
      roundPick: indexInRound + 1,
      teamId,
      playerId: player.id,
      keeper: false,
    });
  }

  return {
    settings: {
      type: "SNAKE",
      pickOrder,
      rounds: 16,
      keeperCount: 0,
      timePerSelectionSeconds: 90,
    },
    completed: false,
    inProgress: true,
    picks,
  };
}

export function buildDemoLeague(opts: DemoOptions = {}): { league: League; freeAgents: Player[] } {
  const teamCount = opts.teamCount ?? 12;
  const week = opts.week ?? 6;
  const rand = rng((opts.seed ?? 20260825) + 7);
  const players = buildDemoPlayers(opts);

  const lineupSlots = [
    { slot: "QB", count: 1 },
    { slot: "RB", count: 2 },
    { slot: "WR", count: 2 },
    { slot: "TE", count: 1 },
    { slot: "FLEX", count: 1 },
    { slot: "DST", count: 1 },
    { slot: "K", count: 1 },
  ];

  /**
   * Positions in the order a roster fills up. Used as a snake-draft template so
   * every team ends up with a comparable roster: allocating position by position
   * in team order instead would hand team one the top five backs *and* the top
   * five receivers, producing a league nobody else can compete in.
   */
  const draftTemplate: Position[] = [
    "RB", "WR", "RB", "WR", "WR", "TE", "QB", "RB",
    "WR", "RB", "QB", "TE", "RB", "WR", "K", "DST",
  ];

  const byPos = new Map<Position, Player[]>();
  for (const p of players) {
    const list = byPos.get(p.position) ?? [];
    list.push(p);
    byPos.set(p.position, list);
  }
  for (const list of byPos.values()) list.sort((a, b) => b.seasonProjectedPoints - a.seasonProjectedPoints);

  const cursors: Record<string, number> = {};
  const taken = new Set<number>();
  const rosters = new Map<number, RosterSlot[]>();
  for (let t = 0; t < teamCount; t++) rosters.set(t, []);

  // Snake allocation: order reverses each round, so no seat compounds an
  // advantage across the whole draft.
  for (let round = 0; round < draftTemplate.length; round++) {
    const pos = draftTemplate[round];
    const pool = byPos.get(pos) ?? [];
    const order = Array.from({ length: teamCount }, (_, i) => i);
    if (round % 2 === 1) order.reverse();

    for (const t of order) {
      const idx = cursors[pos] ?? 0;
      const player = pool[idx];
      cursors[pos] = idx + 1;
      if (!player) continue;
      taken.add(player.id);
      rosters.get(t)!.push({ slot: "BE", player, benched: true });
    }
  }

  const teams: Team[] = [];
  for (let t = 0; t < teamCount; t++) {
    const roster = rosters.get(t)!;

    // Fill the starting lineup naively -- deliberately imperfect, so the
    // optimizer has something to improve on in the demo.
    const assigned = new Set<number>();
    for (const { slot, count } of lineupSlots) {
      for (let c = 0; c < count; c++) {
        const pick = roster.find(
          (r) => !assigned.has(r.player.id) && r.player.eligibleSlots.includes(slot),
        );
        if (!pick) continue;
        assigned.add(pick.player.id);
        pick.slot = slot;
        pick.benched = false;
      }
    }

    const wins = Math.floor(rand() * (week - 1));
    teams.push({
      id: t + 1,
      name: `${["Gridiron", "Turbo", "Steel", "Midnight", "Rocket", "Iron", "Coastal", "Neon", "Granite", "Velvet", "Copper", "Atomic"][t % 12]} ${["Wolves", "Kings", "Comets", "Bandits", "Titans", "Foxes", "Hawks", "Miners", "Racers", "Owls", "Rhinos", "Jets"][(t * 5) % 12]}`,
      abbrev: `T${t + 1}`,
      owners: t === 0 ? ["{DEMO-USER}"] : [`{OWNER-${t}}`],
      wins,
      losses: week - 1 - wins,
      ties: 0,
      pointsFor: round2(90 + rand() * 40 * (week - 1)),
      pointsAgainst: round2(90 + rand() * 40 * (week - 1)),
      faabRemaining: Math.round(20 + rand() * 80),
      roster,
    });
  }

  // A full-season rotating schedule, so remaining matchups exist to simulate.
  // Real ESPN leagues publish the whole schedule up front; a demo that only
  // has the current week would make playoff odds untestable.
  const matchups = [];
  const regularSeasonWeeks = 14;
  const rotation = teams.slice(1).map((t) => t.id);
  for (let w = 1; w <= regularSeasonWeeks; w++) {
    const order = [teams[0].id, ...rotate(rotation, w - 1)];
    for (let i = 0; i < order.length / 2; i++) {
      const homeId = order[i];
      const awayId = order[order.length - 1 - i];
      if (homeId === undefined || awayId === undefined || homeId === awayId) continue;
      const played = w < week;
      const isCurrent = w === week;
      matchups.push({
        week: w,
        home: {
          teamId: homeId,
          points: played || isCurrent ? round2(rand() * 90) : 0,
          projectedPoints: round2(95 + rand() * 30),
        },
        away: {
          teamId: awayId,
          points: played || isCurrent ? round2(rand() * 90) : 0,
          projectedPoints: round2(95 + rand() * 30),
        },
        live: isCurrent,
      });
    }
  }

  const league: League = {
    id: "demo",
    settings: {
      name: "Demo League (no ESPN credentials configured)",
      size: teamCount,
      currentWeek: week,
      seasonId: 2026,
      lineupSlots,
      benchSlots: 6,
      irSlots: 1,
      isPPR: true,
      pointsPerReception: 0.5,
      faabBudget: 100,
      usesFaab: true,
      scoringRules: [
        { statId: 3, points: 0.04, standard: 0.04 },
        { statId: 4, points: 6, standard: 4 },
        { statId: 20, points: -2, standard: -2 },
        { statId: 24, points: 0.1, standard: 0.1 },
        { statId: 25, points: 6, standard: 6 },
        { statId: 42, points: 0.1, standard: 0.1 },
        { statId: 43, points: 6, standard: 6 },
        { statId: 53, points: 0.5, standard: 0 },
        { statId: 72, points: -2, standard: -2 },
      ],
      draft: {
        type: "SNAKE",
        pickOrder: Array.from({ length: teamCount }, (_, i) => i + 1),
        rounds: 16,
        keeperCount: 0,
        timePerSelectionSeconds: 90,
      },
      playoffTeamCount: 6,
      regularSeasonWeeks: 14,
    },
    teams,
    matchups,
    myTeamId: 1,
  };

  const freeAgents = players.filter((p) => !taken.has(p.id)).slice(0, 150);
  return { league, freeAgents };
}

/** Round-robin rotation: fix the first team, cycle the rest. */
function rotate(ids: number[], by: number): number[] {
  if (!ids.length) return ids;
  const shift = by % ids.length;
  return [...ids.slice(shift), ...ids.slice(0, shift)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
