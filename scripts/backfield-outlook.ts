/**
 * Which backfields have a primary back this coming season, and which are open.
 *
 * Last season's shares say who owned each backfield then. This is the forward
 * question, and it is mostly a question about turnover: an 80% back who
 * returns with no new competition is a primary; the same share means nothing
 * if he left, and less than it looks if his team just spent a high pick on a
 * rookie. So each backfield is read as returning share plus departures plus
 * arrivals, and classified -- with the honest residue listed as OPEN, which is
 * the shortlist worth taking to the discourse.
 *
 *   npm run outlook
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { fetchSnapShares } = await import("../src/lib/sources/snapCounts");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { backfieldShares } = await import("../src/lib/engine/backfield");
const { normalizeTeam } = await import("../src/lib/engine/teamChange");

/**
 * What the beat coverage and discourse add on the backfields the data calls
 * open. Checked 2026-08-27 against Yahoo's camp-battle coverage, SI, ESPN's
 * depth-chart battles piece and Panthers beat reporting; the r/fantasyfootball
 * discourse the coverage aggregates points the same ways. An overlay, dated,
 * because camp reporting goes stale by the week -- rerun the searches before
 * trusting this after early September.
 */
const CAMP_OVERLAY_2026: Record<string, { verdict: "LEAN PRIMARY" | "COMMITTEE"; note: string }> = {
  JAX: {
    verdict: "LEAN PRIMARY",
    note: "Camp says Tuten: strong OTAs, and his only added competition (Chris Rodriguez) has missed time after foot surgery. The vacancy Etienne left is his to lose.",
  },
  PIT: {
    verdict: "COMMITTEE",
    note: "Camp says Warren and Dowdle split it -- and Dowdle may have the edge, knowing Mike McCarthy's offence from Dallas. Do not pay Warren's incumbency.",
  },
  SEA: {
    verdict: "COMMITTEE",
    note: "Charbonnet is hurt, Price was added, and a rookie (Emmanuel Wilson) was drafted behind him. Three-way until someone claims it.",
  },
  CAR: {
    verdict: "COMMITTEE",
    note: "The discourse calls this backfield a fantasy nightmare outright: Brooks is two ACL tears and nine NFL carries, behind poor run blocking, with Trevor Etienne and Dillon in rotation. Avoid rather than adjudicate.",
  },
};

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league, ids] = await Promise.all([
    fetchDraftPool(creds),
    fetchLeague(creds),
    fetchPlayerIdIndex(),
  ]);
  const lastSeason = league.settings.seasonId - 1;
  const lines = await fetchSeasonStats(lastSeason);
  const shares = backfieldShares(lines);
  let snapShares = new Map<string, { share: number; games: number }>();
  try {
    snapShares = await fetchSnapShares(lastSeason);
  } catch {
    // Notes just say less.
  }

  interface Back {
    name: string;
    adp: number;
    lastTeam: string | null;
    lastShare: number | null;
    snapShare: number | null;
    rookieRound: number | null;
  }

  // Every rostered back in the pool, with where he was and what he owned.
  const byTeam = new Map<string, Back[]>();
  for (const p of pool) {
    if (p.position !== "RB") continue;
    const team = normalizeTeam(p.proTeam);
    if (!team || team === "FA") continue;
    const identity = ids.byEspnId.get(p.id);
    const share = identity?.gsisId ? shares.get(identity.gsisId) : undefined;
    const snaps = identity?.pfrId ? snapShares.get(identity.pfrId) : undefined;
    const rookie = identity?.draftYear === league.settings.seasonId;
    byTeam.set(team, [
      ...(byTeam.get(team) ?? []),
      {
        name: p.name,
        adp: p.averageDraftPosition,
        lastTeam: share ? share.team : null,
        lastShare: share ? share.share : null,
        snapShare: snaps && snaps.games >= 6 ? snaps.share : null,
        rookieRound: rookie ? (identity?.draftRound ?? 7) : null,
      },
    ]);
  }

  // Who left each backfield: a 2025 share holder whose current team differs.
  const departed = new Map<string, Array<{ name: string; share: number }>>();
  for (const share of shares.values()) {
    if (share.share < 0.15) continue;
    const nowOn = pool.find((p) => {
      const identity = ids.byEspnId.get(p.id);
      return identity?.gsisId === share.gsisId;
    });
    const currentTeam = nowOn ? normalizeTeam(nowOn.proTeam) : null;
    if (currentTeam !== share.team) {
      departed.set(share.team, [
        ...(departed.get(share.team) ?? []),
        { name: share.name, share: share.share },
      ]);
    }
  }

  interface Verdict {
    team: string;
    verdict: "PRIMARY" | "LEAN PRIMARY" | "COMMITTEE" | "OPEN";
    detail: string;
  }
  const verdicts: Verdict[] = [];

  for (const [team, backs] of byTeam) {
    const sorted = [...backs].sort((a, b) => a.adp - b.adp);
    const lead = sorted[0];
    const incumbent = sorted.find((b) => b.lastTeam === team && (b.lastShare ?? 0) >= 0.5);
    const strongIncumbent = incumbent && (incumbent.lastShare ?? 0) >= 0.65;
    const rookieCapital = sorted.find((b) => b.rookieRound !== null && b.rookieRound <= 2);
    const bigArrival = sorted.find(
      (b) => b.lastTeam && b.lastTeam !== team && (b.lastShare ?? 0) >= 0.45 && b.adp < 120,
    );
    const departures = (departed.get(team) ?? []).sort((a, b) => b.share - a.share);
    const leadDeparted = departures[0] && departures[0].share >= 0.5;

    if (strongIncumbent && !rookieCapital && !bigArrival) {
      verdicts.push({
        team,
        verdict: "PRIMARY",
        detail: `${incumbent.name} returns off ${((incumbent.lastShare ?? 0) * 100).toFixed(0)}% of the carries${incumbent.snapShare !== null ? ` (${(incumbent.snapShare * 100).toFixed(0)}% of snaps)` : ""} with no new competition of consequence.`,
      });
    } else if (incumbent && !rookieCapital && !bigArrival) {
      verdicts.push({
        team,
        verdict: "LEAN PRIMARY",
        detail: `${incumbent.name} returns off ${((incumbent.lastShare ?? 0) * 100).toFixed(0)}% of the carries -- a lead, not a lock.`,
      });
    } else if (incumbent && (rookieCapital || bigArrival)) {
      const rival = rookieCapital
        ? `round-${rookieCapital.rookieRound} rookie ${rookieCapital.name}`
        : `${bigArrival!.name} arriving from ${bigArrival!.lastTeam}`;
      verdicts.push({
        team,
        verdict: "OPEN",
        detail: `${incumbent.name} held ${((incumbent.lastShare ?? 0) * 100).toFixed(0)}% but the team added ${rival}. Somebody paid to change this backfield.`,
      });
    } else if (leadDeparted) {
      verdicts.push({
        team,
        verdict: "OPEN",
        detail: `${departures[0].name} took his ${(departures[0].share * 100).toFixed(0)}% elsewhere. ${lead ? `${lead.name} is the ADP favourite for the vacancy` : "No clear heir"}${rookieCapital && rookieCapital.name !== lead?.name ? `, against round-${rookieCapital.rookieRound} rookie ${rookieCapital.name}` : ""}.`,
      });
    } else {
      verdicts.push({
        team,
        verdict: "COMMITTEE",
        detail: `Nobody returning held half this backfield${lead ? `; ${lead.name} leads it by draft position` : ""}.`,
      });
    }
  }

  const order = { PRIMARY: 0, "LEAN PRIMARY": 1, COMMITTEE: 2, OPEN: 3 };
  verdicts.sort((a, b) => order[a.verdict] - order[b.verdict] || a.team.localeCompare(b.team));

  // The camp overlay settles what turnover alone cannot, and is applied last
  // and visibly, so a reader can see which verdicts rest on reporting.
  if (league.settings.seasonId === 2026) {
    for (const v of verdicts) {
      const camp = CAMP_OVERLAY_2026[v.team];
      if (camp && v.verdict === "OPEN") {
        v.verdict = camp.verdict;
        v.detail = `${v.detail} ${camp.note}`;
        (v as { fromCamp?: boolean }).fromCamp = true;
      }
    }
    verdicts.sort((a, b) => order[a.verdict] - order[b.verdict] || a.team.localeCompare(b.team));
  }

  console.log(`Backfields for ${league.settings.seasonId}, read from turnover plus camp reporting:\n`);
  for (const v of verdicts) {
    const marker = (v as { fromCamp?: boolean }).fromCamp ? " †" : "";
    console.log(`  ${v.team.padEnd(4)} ${v.verdict.padEnd(13)}${marker} ${v.detail}`);
  }
  const open = verdicts.filter((v) => v.verdict === "OPEN");
  console.log(
    `\n  † settled by camp reporting (checked 2026-08-27), not by the data -- goes stale by the week.` +
      (open.length
        ? `\n  Still open: ${open.map((v) => v.team).join(", ")}.`
        : `\n  Nothing is left open once the reporting is in.`),
  );
}

function loadEnvFile(file: string) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent env file is fine.
  }
}

await main();
