/**
 * Everything the draft board needs, checked in one pass.
 *
 * `npm run verify` answers "is the ESPN wiring right", which is where setup
 * goes wrong. This answers the draft-morning question, which is different:
 * every outside source the board leans on, checked reachable; every cache that
 * backs one, warmed and dated; and one real board built end to end with every
 * source attached, proving they contributed rather than merely loaded.
 *
 * The distinction between a failure and a warning is the fallback. An
 * unreachable ESPN is a failure, because nothing works without it. An
 * unreachable ADP market is a warning, because the board degrades to
 * estimated spreads -- and a warm cache turns even that into a non-event,
 * which is why this script's other job is to do the warming. Run it the
 * morning of the draft: whatever it fetches is what draft night falls back
 * on.
 *
 *   npm run readiness
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague, fetchDraftStatus } = await import("../src/lib/espn/league");
const { fetchAdpMarket } = await import("../src/lib/sources/adp");
const { fetchBackfieldSource } = await import("../src/lib/sources/backfieldSource");
const { fetchSecondOpinion } = await import("../src/lib/sources/secondOpinion");
const { fetchPlayerIdIndex } = await import("../src/lib/sources/playerIds");
const { buildDraftBoard } = await import("../src/lib/engine/draft");

let failures = 0;
let warnings = 0;

function ok(message: string) {
  console.log(`  ✓ ${message}`);
}
function warn(message: string) {
  warnings++;
  console.log(`  ⚠ ${message}`);
}
function bad(message: string) {
  failures++;
  console.log(`  ✗ ${message}`);
}

async function main() {
  const creds = credentialsFromEnv();
  console.log(`Draft readiness · league ${creds.leagueId} · season ${creds.seasonId}\n`);

  // --- ESPN, without which nothing works ---
  console.log("ESPN");
  let league;
  let pool;
  let status;
  try {
    [league, pool, status] = await Promise.all([
      fetchLeague(creds),
      fetchDraftPool(creds),
      fetchDraftStatus(creds),
    ]);
    ok(`league "${league.settings.name}" · ${league.settings.size} teams`);
    ok(`draft pool: ${pool.length} players`);
  } catch (err) {
    bad(`ESPN unreachable: ${err instanceof Error ? err.message : err}. Nothing works without this -- run npm run verify.`);
    finish();
    return;
  }

  if (league.myTeamId === undefined) {
    bad("your team could not be identified -- check the SWID cookie");
  } else {
    ok(`your team resolved (id ${league.myTeamId})`);
  }

  const draftDate = status.settings.startsAt ? new Date(status.settings.startsAt) : null;
  if (status.settings.pickOrder.length) {
    ok(`pick order published: seat ${league.myTeamId !== undefined ? status.settings.pickOrder.indexOf(league.myTeamId) + 1 : "?"} of ${status.settings.pickOrder.length}`);
  } else {
    warn(
      `pick order not published yet${draftDate ? ` (draft ${draftDate.toLocaleString()})` : ""} -- ` +
        `normal for a DRAFT_START order league; it appears when the room opens`,
    );
  }

  // --- Outside sources, each of which degrades rather than breaks ---
  console.log("\nOutside sources");
  let market;
  try {
    market = await fetchAdpMarket(league.settings);
    if (market.quoted === 0) {
      warn("ADP market returned no players -- survival spreads will be estimated");
    } else {
      const health = `${market.quoted} players across ${market.sample} drafts`;
      if (market.stale) warn(`ADP market from a stale cache (${health}) -- fine, but it will not refresh mid-draft`);
      else ok(`ADP market live: ${health}`);
    }
  } catch (err) {
    warn(`ADP market unreachable (${err instanceof Error ? err.message : err}) -- estimated spreads instead`);
  }

  let crosswalk;
  try {
    crosswalk = await fetchPlayerIdIndex();
    const matched = pool
      .slice(0, 200)
      .filter((p) => crosswalk!.byEspnId.has(p.id)).length;
    if (matched < 150) warn(`crosswalk matched only ${matched}/200 of the top pool -- history features will be thin`);
    else ok(`player crosswalk: ${matched}/200 of the top pool matched${crosswalk.stale ? " (stale cache)" : ""}`);
  } catch (err) {
    warn(`player crosswalk unreachable (${err instanceof Error ? err.message : err}) -- backfield and second-opinion notes disappear`);
  }

  let backfield;
  try {
    backfield = await fetchBackfieldSource(league.settings.seasonId);
    const withRoles = pool.filter((p) => p.position === "RB" && backfield!.roleFor(p)).length;
    if (withRoles === 0) warn("backfield source loaded but no back has a role -- check nflverse season availability");
    else ok(`backfield usage: ${withRoles} backs carry a role`);
  } catch (err) {
    warn(`backfield source failed (${err instanceof Error ? err.message : err})`);
  }

  let secondOpinion;
  try {
    secondOpinion = await fetchSecondOpinion(league.settings);
    const withOpinions = pool.slice(0, 100).filter((p) => secondOpinion!.for(p)).length;
    if (withOpinions === 0) warn("second-opinion source loaded but empty -- check nflverse and the crosswalk");
    else ok(`second opinion: ${withOpinions} of the top 100 have one (aging curve on ${secondOpinion.fitted} pairs)`);
  } catch (err) {
    warn(`second-opinion source failed (${err instanceof Error ? err.message : err})`);
  }

  // --- The caches draft night falls back on ---
  console.log("\nCaches (what a mid-draft outage falls back on)");
  try {
    const dir = join(process.cwd(), ".cache", "sources");
    const files = readdirSync(dir);
    if (!files.length) {
      warn("cache directory is empty -- the fetches above should have filled it; a mid-draft outage has no fallback");
    } else {
      const now = Date.now();
      let oldest = 0;
      for (const file of files) {
        oldest = Math.max(oldest, now - statSync(join(dir, file)).mtimeMs);
      }
      const hours = oldest / 3_600_000;
      if (hours > 48) warn(`${files.length} cached files, oldest ${hours.toFixed(0)}h old -- rerun this closer to the draft`);
      else ok(`${files.length} cached files, oldest ${hours.toFixed(1)}h -- warm`);
    }
  } catch {
    warn("no cache directory -- a mid-draft outage has no fallback");
  }

  // --- One real board, every source attached ---
  console.log("\nEnd to end");
  const board = buildDraftBoard(
    pool,
    league.settings,
    {
      pickNumber: 1,
      nextPickNumber: league.settings.size * 2,
      drafted: new Set(),
      myRoster: [],
      market,
      backfield,
      secondOpinion,
    },
    40,
  );
  if (!board.recommendations.length) {
    bad("the board returned no recommendations");
  } else {
    ok(`board built: ${board.recommendations.length} recommendations, ${board.tiers.length} bands`);

    // Each check looks where its source actually shows up. The first version
    // scanned the top forty for a kicker note and warned when it found none --
    // but no kicker belongs in the top forty at pick one, so it was warning
    // about the board being right.
    const codes = new Set(board.recommendations.flatMap((r) => r.reasons.map((x) => x.code)));
    if (board.recommendations.some((r) => r.survivalProbability < 1)) ok("survival model contributed");
    else warn("every survival probability is exactly 1 -- the model is not running");
    if (codes.has("second_opinion") || codes.has("changed_teams")) ok("second opinion contributed");
    else warn("no second-opinion note in the top 40 -- possible, but worth a look");
    if (codes.has("backfield_workhorse") || codes.has("backfield_committee")) ok("backfield usage contributed");
    else warn("no backfield note in the top 40 -- possible, but worth a look");

    const kicker = pool.find((p) => p.position === "K");
    if (kicker) {
      const late = buildDraftBoard(
        pool,
        league.settings,
        {
          pickNumber: league.settings.size * 13 + 1,
          nextPickNumber: league.settings.size * 14,
          drafted: new Set(),
          myRoster: [],
          market,
          backfield,
          secondOpinion,
        },
        60,
      );
      const noted = late.recommendations.some((r) =>
        r.player.position === "K" && r.reasons.some((x) => x.code === "kicker_lottery"),
      );
      if (noted) ok("kicker note contributed (checked on a late-round board)");
      else warn("no kicker note even on a late-round board");
    }
  }

  finish(draftDate);
}

function finish(draftDate?: Date | null) {
  console.log(
    `\n${failures ? "✗" : warnings ? "⚠" : "✓"} ${failures} failure(s), ${warnings} warning(s)` +
      (draftDate ? ` · draft ${draftDate.toLocaleString()}` : ""),
  );
  if (failures) process.exitCode = 1;
}

function loadEnvFile(file: string) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  } catch {
    // Absent env file is fine; credentialsFromEnv reports what is missing.
  }
}

await main();
