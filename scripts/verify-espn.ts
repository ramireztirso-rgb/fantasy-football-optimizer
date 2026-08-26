/**
 * Confirms the ESPN wiring against a real league.
 *
 * Run this first, before the app: it isolates the two things that actually go
 * wrong (wrong league id, stale cookies) from everything else, and prints what
 * it managed to parse so a partial success is visible rather than silent.
 *
 *   npm run verify
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv, EspnError } = await import("../src/lib/espn/client");
const { fetchLeague, fetchFreeAgents } = await import("../src/lib/espn/league");
const { optimizeLineup } = await import("../src/lib/engine/lineup");
const { buildWaiverReport } = await import("../src/lib/engine/waivers");

async function main() {
  let creds;
  try {
    creds = credentialsFromEnv();
  } catch (err) {
    fail(err);
    return;
  }

  console.log(`League ${creds.leagueId}, season ${creds.seasonId}`);
  console.log(`espn_s2: ${creds.espnS2 ? "set" : "NOT SET"}   SWID: ${creds.swid ? "set" : "NOT SET"}`);
  if (!creds.espnS2 || !creds.swid) {
    console.log("  Private leagues need both. Public leagues work without them.\n");
  } else {
    console.log("");
  }

  let league;
  try {
    league = await fetchLeague(creds);
  } catch (err) {
    fail(err);
    return;
  }

  console.log(`✓ Connected: ${league.settings.name}`);
  console.log(`  ${league.settings.size} teams · week ${league.settings.currentWeek} · ${league.settings.isPPR ? `${league.settings.pointsPerReception} PPR` : "standard"}`);
  console.log(`  Starting lineup: ${league.settings.lineupSlots.map((s) => `${s.count} ${s.slot}`).join(", ")}`);
  console.log(`  Acquisitions: ${league.settings.usesFaab ? `FAAB, $${league.settings.faabBudget} budget` : "waiver priority"}`);

  const myTeam = league.teams.find((t) => t.id === league.myTeamId);
  if (!myTeam) {
    console.log("\n✗ Could not identify your team.");
    console.log("  The SWID cookie is what maps you to a team. Check it matches the account that owns your team.");
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ Your team: ${myTeam.name} (${myTeam.wins}-${myTeam.losses}${myTeam.ties ? `-${myTeam.ties}` : ""})`);
  console.log(`  ${myTeam.roster.length} players rostered${myTeam.faabRemaining !== undefined ? `, $${myTeam.faabRemaining} FAAB left` : ""}`);

  // Projections are the most fragile part of the parse: ESPN mixes projected
  // and actual stat blocks in one array, so an empty result here means the
  // stat-block filter needs revisiting for this season.
  const withProjections = myTeam.roster.filter((r) => r.player.projectedPoints > 0).length;
  console.log(`  ${withProjections}/${myTeam.roster.length} players have a week ${league.settings.currentWeek} projection`);
  if (withProjections === 0) {
    console.log("  ⚠ No projections parsed. If this is the offseason that is expected; mid-season it is a bug.");
  }

  const lineup = optimizeLineup(myTeam, league.settings, { week: league.settings.currentWeek });
  console.log(`\n✓ Lineup optimizer: ${lineup.optimalPoints.toFixed(1)} optimal vs ${lineup.currentPoints.toFixed(1)} current`);
  if (lineup.changes.length) {
    console.log(`  Top move: start ${lineup.changes[0].benchPlayer.name} (+${lineup.changes[0].gain.toFixed(1)})`);
  } else {
    console.log("  Your lineup is already optimal.");
  }

  try {
    const freeAgents = await fetchFreeAgents(creds, league.settings.currentWeek, 100);
    console.log(`\n✓ Waiver pool: ${freeAgents.length} available players`);
    const report = buildWaiverReport(league, myTeam, freeAgents, {
      week: league.settings.currentWeek,
      limit: 3,
    });
    for (const target of report.targets) {
      console.log(
        `  ${target.player.name} (${target.player.position}) — ${target.suggestedBid !== undefined ? `$${target.suggestedBid}` : `${target.suggestedBidPercent}%`}: ${target.reasons[0]?.detail ?? ""}`,
      );
    }
  } catch (err) {
    console.log(`\n⚠ Free agent query failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("  The league itself loaded, so this is the x-fantasy-filter query specifically.");
  }

  console.log("\nAll good. Start the app with: npm run dev");
}

function fail(err: unknown) {
  process.exitCode = 1;
  if (err instanceof EspnError) {
    console.error(`\n✗ ${err.message}`);
    if (err.hint) console.error(`  ${err.hint}`);
  } else {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Minimal .env reader so the script does not need a dotenv dependency. */
function loadEnvFile(name: string) {
  try {
    const text = readFileSync(resolve(process.cwd(), name), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // First file wins, matching Next.js's .env.local precedence.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Missing file is fine -- the variables may come from the shell.
  }
}

await main();
