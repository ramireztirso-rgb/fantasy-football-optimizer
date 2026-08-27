/**
 * Who leads each passing game this coming season, at receiver and tight end.
 *
 * The backfield version of this question is about carries; the receiver
 * version is about targets, which in this league are the entire currency --
 * receivers and tight ends earn half a point per catch and half per first
 * down, so the man the quarterback looks for first is the one the scoring
 * pays. Last season's target shares say who that was; turnover -- departures,
 * arrivals, and draft capital -- says how much of it to believe for next
 * season. What the data cannot settle it lists as contested, which is the
 * shortlist worth taking to camp reporting and the discourse.
 *
 *   npm run targets
 *   npm run targets -- --team DET
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchSeasonStats } = await import("../src/lib/sources/nflverse");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { normalizeTeam } = await import("../src/lib/engine/teamChange");

const args = process.argv.slice(2);
const onlyTeam = readFlag("--team")?.toUpperCase();

/** Share of a team's targets that makes a receiver its alpha. */
const ALPHA = 0.24;
/** Share that makes him a lead without settling anything. */
const LEAD = 0.19;
/** Share below which a departure or arrival is not worth tracking. */
const MEANINGFUL = 0.12;
/** A tight end on this many of his team's targets is a real part of the plan. */
const TE_FEATURED = 0.16;

/**
 * What camp reporting and the discourse settle among the contested passing
 * games. Checked 2026-08-27 against SI, PhillyVoice, PFN and FTN coverage;
 * carried dated because August reporting rots by the week. Rooms the
 * reporting could not settle stay CONTESTED, which is the honest verdict.
 */
const CAMP_OVERLAY_2026: Record<string, { verdict: "ALPHA" | "LEAD"; note: string }> = {
  PHI: {
    verdict: "ALPHA",
    note: "Camp says the room belongs to DeVonta Smith with A.J. Brown traded to New England -- 112 targets last year while sharing, now unshared. One flag: he has missed camp time with a hamstring.",
  },
  NE: {
    verdict: "ALPHA",
    note: "A.J. Brown is the arrival the departure line hid: New England acquired him for Drake Maye's third year, and the coverage ranks him a top-five receiver. The alpha, immediately.",
  },
  DEN: {
    verdict: "ALPHA",
    note: "Camp says Waddle is the one -- 22.8% target share on a broken Miami offence, now with a real quarterback -- and Sutton keeps his complementary thousand-yard role rather than the lead.",
  },
  NO: {
    verdict: "ALPHA",
    note: "Olave finished WR6 and his new competition, rookie Jordyn Tyson, arrived hurt and is expected to miss the start. The 33% share holds for now.",
  },
  BUF: {
    verdict: "LEAD",
    note: "Buffalo paid a second-round pick for DJ Moore, and the coverage hands him the lead over Shakir, who stays the reliable slot at ~100 targets. Lead, not alpha -- this offence spreads it.",
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

  // Target share, per player, against his team's whole passing volume --
  // backs included in the denominator, because a target that goes to the back
  // is one the receivers did not get.
  const teamTargets = new Map<string, number>();
  for (const l of lines) {
    if (!l.team || l.targets <= 0) continue;
    const team = normalizeTeam(l.team);
    teamTargets.set(team, (teamTargets.get(team) ?? 0) + l.targets);
  }
  interface ShareRecord {
    gsisId: string;
    name: string;
    position: string;
    team: string;
    share: number;
    firstDowns: number;
  }
  const shareByGsis = new Map<string, ShareRecord>();
  for (const l of lines) {
    if (!["WR", "TE"].includes(l.position) || !l.team || l.targets <= 0) continue;
    const team = normalizeTeam(l.team);
    const total = teamTargets.get(team) ?? 0;
    if (total < 300) continue;
    shareByGsis.set(l.gsisId, {
      gsisId: l.gsisId,
      name: l.name,
      position: l.position,
      team,
      share: l.targets / total,
      firstDowns: l.receivingFirstDowns,
    });
  }

  interface Catcher {
    name: string;
    position: string;
    adp: number;
    lastTeam: string | null;
    lastShare: number | null;
    rookieRound: number | null;
  }
  const byTeam = new Map<string, Catcher[]>();
  for (const p of pool) {
    if (!["WR", "TE"].includes(p.position)) continue;
    const team = normalizeTeam(p.proTeam);
    if (!team || team === "FA") continue;
    const identity = ids.byEspnId.get(p.id);
    const record = identity?.gsisId ? shareByGsis.get(identity.gsisId) : undefined;
    const rookie = identity?.draftYear === league.settings.seasonId;
    byTeam.set(team, [
      ...(byTeam.get(team) ?? []),
      {
        name: p.name,
        position: p.position,
        adp: p.averageDraftPosition,
        lastTeam: record ? record.team : null,
        lastShare: record ? record.share : null,
        rookieRound: rookie ? (identity?.draftRound ?? 7) : null,
      },
    ]);
  }

  // Who took their targets elsewhere.
  const departed = new Map<string, Array<{ name: string; share: number }>>();
  for (const record of shareByGsis.values()) {
    if (record.share < MEANINGFUL) continue;
    const nowOn = pool.find((p) => ids.byEspnId.get(p.id)?.gsisId === record.gsisId);
    const currentTeam = nowOn ? normalizeTeam(nowOn.proTeam) : null;
    if (currentTeam !== record.team) {
      departed.set(record.team, [
        ...(departed.get(record.team) ?? []),
        { name: record.name, share: record.share },
      ]);
    }
  }

  interface Verdict {
    team: string;
    verdict: "ALPHA" | "LEAD" | "SPREAD" | "CONTESTED";
    detail: string;
    te: string | null;
    fromCamp?: boolean;
  }
  const verdicts: Verdict[] = [];

  for (const [team, catchers] of byTeam) {
    if (onlyTeam && team !== onlyTeam) continue;
    const sorted = [...catchers].sort((a, b) => a.adp - b.adp);
    const returningWrs = sorted.filter(
      (c) => c.position === "WR" && c.lastTeam === team && c.lastShare !== null,
    );
    const incumbent = [...returningWrs].sort((a, b) => (b.lastShare ?? 0) - (a.lastShare ?? 0))[0];
    const arrival = sorted.find(
      (c) => c.position === "WR" && c.lastTeam && c.lastTeam !== team && (c.lastShare ?? 0) >= MEANINGFUL && c.adp < 150,
    );
    const rookieCapital = sorted.find(
      (c) => c.position === "WR" && c.rookieRound !== null && c.rookieRound <= 2,
    );
    const departures = (departed.get(team) ?? []).sort((a, b) => b.share - a.share);
    const leadDeparted = departures[0] && departures[0].share >= LEAD;

    // The tight end read rides along: featured or not, one line.
    const returningTe = sorted.find(
      (c) => c.position === "TE" && c.lastTeam === team && (c.lastShare ?? 0) >= TE_FEATURED,
    );
    const te = returningTe
      ? `${returningTe.name} is a featured tight end (${((returningTe.lastShare ?? 0) * 100).toFixed(0)}% of targets)`
      : null;

    const pct = (x: number | null | undefined) => `${((x ?? 0) * 100).toFixed(0)}%`;

    if (incumbent && (incumbent.lastShare ?? 0) >= ALPHA && !arrival && !rookieCapital && !leadDeparted) {
      verdicts.push({
        team,
        verdict: "ALPHA",
        detail: `${incumbent.name} returns off ${pct(incumbent.lastShare)} of the targets with nothing changed around him.`,
        te,
      });
    } else if (incumbent && (incumbent.lastShare ?? 0) >= LEAD && !arrival && !rookieCapital) {
      verdicts.push({
        team,
        verdict: "LEAD",
        detail: `${incumbent.name} led at ${pct(incumbent.lastShare)} of targets${leadDeparted ? `, and ${departures[0].name}'s ${pct(departures[0].share)} just left -- his share should grow` : " -- a lead, not an alpha"}.`,
        te,
      });
    } else if (
      (incumbent && (arrival || rookieCapital)) ||
      leadDeparted ||
      (!incumbent && (arrival || rookieCapital))
    ) {
      const cause = leadDeparted
        ? `${departures[0].name} took ${pct(departures[0].share)} of the targets elsewhere`
        : arrival
          ? `${arrival.name} arrived from ${arrival.lastTeam} (${pct(arrival.lastShare)} there)`
          : `the team spent a round-${rookieCapital!.rookieRound} pick on ${rookieCapital!.name}`;
      verdicts.push({
        team,
        verdict: "CONTESTED",
        detail: `${incumbent ? `${incumbent.name} held ${pct(incumbent.lastShare)}, but ` : ""}${cause}.`,
        te,
      });
    } else {
      verdicts.push({
        team,
        verdict: "SPREAD",
        detail: `Nobody returning held ${pct(LEAD)} of the targets${sorted[0] ? `; ${sorted[0].name} leads by draft position` : ""}.`,
        te,
      });
    }
  }

  const order = { ALPHA: 0, LEAD: 1, SPREAD: 2, CONTESTED: 3 };
  if (league.settings.seasonId === 2026) {
    for (const v of verdicts) {
      const camp = CAMP_OVERLAY_2026[v.team];
      if (camp && v.verdict === "CONTESTED") {
        v.verdict = camp.verdict;
        v.detail = `${v.detail} ${camp.note}`;
        v.fromCamp = true;
      }
    }
  }
  verdicts.sort((a, b) => order[a.verdict] - order[b.verdict] || a.team.localeCompare(b.team));

  console.log(
    `Passing-game hierarchies for ${league.settings.seasonId}. Targets are this league's\n` +
      `currency for receivers -- half a point per catch and per first down.\n`,
  );
  for (const v of verdicts) {
    console.log(
      `  ${v.team.padEnd(4)} ${v.verdict.padEnd(10)}${v.fromCamp ? "†" : " "} ${v.detail}${v.te ? ` ${v.te}.` : ""}`,
    );
  }
  const contested = verdicts.filter((v) => v.verdict === "CONTESTED");
  console.log(
    `\n  † settled by camp reporting, checked 2026-08-27 -- goes stale by the week.` +
      (contested.length
        ? `\n  Still genuinely contested, where the reporting settles nothing yet:\n  ${contested.map((v) => v.team).join(", ")}.`
        : ""),
  );
}

function readFlag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
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
