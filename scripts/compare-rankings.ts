/**
 * Any outside ranking list, set against the market and this board.
 *
 * For a pasted list -- a Reddit ranking, an analyst's top-150, a friend's
 * tiers. The point is never to adopt the list; it is to see where a ranker,
 * the market, and this board disagree, because a player all three agree on is
 * settled and a player they split three ways is a decision you will actually
 * face on the clock.
 *
 *   npm run rankings -- path/to/list.txt
 *
 * The file can be messy: "1. Ja'Marr Chase", "12) Puka Nacua WR LAR",
 * "QB1 Josh Allen" all parse. Lines that do not look like a ranked player are
 * skipped and counted, so a bad paste announces itself.
 */

import { readFileSync } from "node:fs";

loadEnvFile(".env.local");
loadEnvFile(".env");

const { credentialsFromEnv } = await import("../src/lib/espn/client");
const { fetchDraftPool, fetchLeague } = await import("../src/lib/espn/league");
const { fetchAdpMarket } = await import("../src/lib/sources/adp");
const { buildDraftBoard } = await import("../src/lib/engine/draft");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("Usage: npm run rankings -- path/to/list.txt");
  process.exit(1);
}

async function main() {
  const creds = credentialsFromEnv();
  const [pool, league] = await Promise.all([fetchDraftPool(creds), fetchLeague(creds)]);
  const market = await fetchAdpMarket(league.settings).catch(() => undefined);

  // Their list, parsed leniently.
  const theirs = new Map<string, number>();
  let skipped = 0;
  let rank = 0;
  for (const raw of readFileSync(file!, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // A leading rank if present; otherwise list order counts the rank.
    const m = line.match(/^(?:#?(\d{1,3})[.):\-\s]+)?\s*([A-Za-z][A-Za-z.'\-\s]+?)(?:\s*[,(].*)?$/);
    const name = m?.[2]?.trim();
    if (!m || !name || name.split(/\s+/).length < 2) {
      skipped++;
      continue;
    }
    rank = m[1] ? Number(m[1]) : rank + 1;
    const key = normalizeName(name);
    if (!theirs.has(key)) theirs.set(key, rank);
  }

  // This board's own order over the same universe: an empty roster at pick
  // one, which is the one moment a global ranking is even well defined here.
  const board = buildDraftBoard(
    pool,
    league.settings,
    { pickNumber: 1, nextPickNumber: league.settings.size * 2, drafted: new Set(), myRoster: [], market },
    160,
  );
  const boardRank = new Map(board.recommendations.map((r, i) => [normalizeName(r.player.name), i + 1]));

  interface Row {
    name: string;
    position: string;
    theirRank: number;
    espnAdp: number;
    ourRank: number | null;
  }
  const rows: Row[] = [];
  let unmatched = 0;
  for (const p of pool) {
    const their = theirs.get(normalizeName(p.name));
    if (their === undefined) continue;
    rows.push({
      name: p.name,
      position: p.position,
      theirRank: their,
      espnAdp: p.averageDraftPosition,
      ourRank: boardRank.get(normalizeName(p.name)) ?? null,
    });
  }
  unmatched = theirs.size - rows.length;

  console.log(
    `Matched ${rows.length} of ${theirs.size} ranked players to the pool` +
      `${unmatched ? ` (${unmatched} unmatched -- usually rookies ESPN lists differently, or defences)` : ""}` +
      `${skipped ? `; ${skipped} lines skipped as not player rows` : ""}.\n`,
  );

  const vsAdp = rows
    .filter((r) => Number.isFinite(r.espnAdp) && r.espnAdp < 170)
    .map((r) => ({ ...r, gap: r.espnAdp - r.theirRank }))
    .sort((a, b) => b.gap - a.gap);

  console.log("They are far higher than your league's room will draft him (ESPN ADP):");
  for (const r of vsAdp.slice(0, 10)) {
    console.log(
      `  ${r.position.padEnd(3)} ${r.name.slice(0, 24).padEnd(24)} their #${String(r.theirRank).padStart(3)}  ESPN ADP ${String(Math.round(r.espnAdp)).padStart(3)}  (+${r.gap.toFixed(0)})`,
    );
  }
  console.log("\nThey are far lower -- players your room will take earlier than they would:");
  for (const r of [...vsAdp].reverse().slice(0, 10)) {
    console.log(
      `  ${r.position.padEnd(3)} ${r.name.slice(0, 24).padEnd(24)} their #${String(r.theirRank).padStart(3)}  ESPN ADP ${String(Math.round(r.espnAdp)).padStart(3)}  (${r.gap.toFixed(0)})`,
    );
  }

  const vsBoard = rows
    .filter((r) => r.ourRank !== null && r.theirRank <= 100)
    .map((r) => ({ ...r, gap: (r.ourRank as number) - r.theirRank }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  console.log("\nBiggest splits with this board's own pick-one ordering:");
  for (const r of vsBoard.slice(0, 10)) {
    console.log(
      `  ${r.position.padEnd(3)} ${r.name.slice(0, 24).padEnd(24)} their #${String(r.theirRank).padStart(3)}  board #${String(r.ourRank).padStart(3)}  (${r.gap > 0 ? "they like him more" : "board likes him more"})`,
    );
  }
  console.log(
    `\n  The reading, not a verdict: where they sit far above ESPN's ADP is where your\n` +
      `  room under-prices a player this ranker believes in -- those fall to you late.\n` +
      `  Where they sit far below, your room will pay a price this ranker would not.`,
  );
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z]/g, "");
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
