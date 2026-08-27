"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, ErrorBox, Loading, Pill } from "@/components/ui";
import { Reasons } from "@/components/Reasons";
import type { DraftBoard } from "@/lib/engine/draft";
import type { LeagueSettings } from "@/lib/domain/types";

/**
 * Draft night's manual mode.
 *
 * ESPN's read API shows nothing during a live draft -- every pick appears only
 * when the draft completes, proven against a real draft room. The room itself
 * speaks a websocket this app does not. So on the night, the picks come from
 * the person watching the room: one tap per pick, and the board reacts the way
 * the live page was always meant to.
 *
 * Built for clock speed. The next pick is almost always near the top of the
 * remaining ADP list, so it is one tap nine times in ten; the search box
 * covers the tenth. Undo exists because fingers slip on a 90-second clock.
 * State survives a page reload -- draft night is exactly when a browser
 * chooses to crash.
 */

interface PoolPlayer {
  id: number;
  name: string;
  position: string;
  proTeam: string;
  adp: number;
}

interface DraftResponse {
  isDemo: boolean;
  settings: LeagueSettings;
  board: DraftBoard;
  available: PoolPlayer[];
}

interface Tracked {
  /** Every drafted player id, in pick order. */
  picks: number[];
  /** Which of those were mine. */
  mine: number[];
  seat: number;
}

const STORAGE_KEY = "manual-draft-v1";

function loadTracked(): Tracked {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Tracked;
  } catch {
    // Fresh state is the correct fallback for unreadable storage.
  }
  return { picks: [], mine: [], seat: 1 };
}

/** My pick numbers in a snake draft from a given seat. */
function myPicks(seat: number, size: number, rounds: number): Set<number> {
  const out = new Set<number>();
  for (let round = 1; round <= rounds; round++) {
    const within = round % 2 === 1 ? seat : size - seat + 1;
    out.add((round - 1) * size + within);
  }
  return out;
}

export default function ManualDraftPage() {
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [data, setData] = useState<DraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => setTracked(loadTracked()), []);

  const save = useCallback((next: Tracked) => {
    setTracked(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Losing persistence is survivable; losing the click is not.
    }
  }, []);

  const load = useCallback(async () => {
    if (!tracked) return;
    try {
      const size = data?.settings.size || 12;
      // Starters plus bench, never IR -- the same rule the engine follows.
      const rounds = data
        ? data.settings.lineupSlots.reduce((n, s) => n + s.count, 0) + data.settings.benchSlots
        : 15;
      const mine = myPicks(tracked.seat, size, rounds);
      const current = tracked.picks.length + 1;
      let next = current;
      while (next <= size * rounds && !mine.has(next)) next++;
      if (next === current) {
        next = current + 1;
        while (next <= size * rounds && !mine.has(next)) next++;
      }
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pickNumber: current,
          nextPickNumber: Math.min(next, size * rounds),
          drafted: tracked.picks,
          myRosterIds: tracked.mine,
          limit: 20,
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      setData((await res.json()) as DraftResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tracked, data?.settings.size]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked]);

  const size = data?.settings.size || 12;
  const roundsNow = data
    ? data.settings.lineupSlots.reduce((n, s) => n + s.count, 0) + data.settings.benchSlots
    : 15;
  const current = (tracked?.picks.length ?? 0) + 1;
  const mine = useMemo(
    () => myPicks(tracked?.seat ?? 1, size, roundsNow),
    [tracked?.seat, size, roundsNow],
  );
  const isMyPick = mine.has(current);

  const mark = (player: PoolPlayer) => {
    if (!tracked) return;
    save({
      ...tracked,
      picks: [...tracked.picks, player.id],
      mine: isMyPick ? [...tracked.mine, player.id] : tracked.mine,
    });
    setQuery("");
  };

  const undo = () => {
    if (!tracked || !tracked.picks.length) return;
    const last = tracked.picks[tracked.picks.length - 1];
    save({
      ...tracked,
      picks: tracked.picks.slice(0, -1),
      mine: tracked.mine.filter((id) => id !== last),
    });
  };

  if (!tracked) return <Loading what="draft tracker" />;

  const filtered = (data?.available ?? [])
    .filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, query ? 8 : 12);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <Card
        title="Manual draft tracking"
        subtitle="ESPN's feed shows nothing until a draft ends, so on the night the picks come from you: one tap each as they happen in the room. The board keeps up."
        right={
          <div className="flex items-center gap-2">
            <label className="text-xs text-chalk-500">
              Seat{" "}
              <select
                value={tracked.seat}
                onChange={(e) => save({ ...tracked, seat: Number(e.target.value) })}
                className="rounded border border-pitch-700 bg-pitch-900 px-1 py-0.5 text-chalk-300"
              >
                {Array.from({ length: size }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={undo}
              className="rounded-lg border border-pitch-700 px-2 py-1 text-xs text-chalk-300 hover:bg-pitch-800"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Clear every tracked pick?")) {
                  save({ picks: [], mine: [], seat: tracked.seat });
                }
              }}
              className="rounded-lg border border-pitch-700 px-2 py-1 text-xs text-chalk-300 hover:bg-pitch-800"
            >
              Reset
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={isMyPick ? "good" : "neutral"}>
            Pick {current}
            {isMyPick ? " — YOUR PICK" : ""}
          </Pill>
          <span className="text-sm text-chalk-500">
            {isMyPick
              ? "Tap the player you take. He goes to your roster."
              : "Tap whoever just came off the board in the ESPN room."}
          </span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search any player…"
          className="mt-4 w-full rounded-lg border border-pitch-700 bg-pitch-900 px-3 py-2 text-sm text-chalk-100 placeholder:text-chalk-600"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => mark(p)}
              className="rounded-lg border border-pitch-700 bg-pitch-800/60 px-3 py-1.5 text-sm text-chalk-200 hover:border-gain-600/50 hover:bg-gain-600/15"
            >
              <span className="font-medium">{p.name}</span>
              <span className="ml-1.5 text-xs text-chalk-500">
                {p.position} · ADP {Math.round(p.adp)}
              </span>
            </button>
          ))}
        </div>
      </Card>

      {error && <ErrorBox error={error} hint="The board could not refresh; your tracked picks are safe." />}

      {data && isMyPick && data.board.recommendations[0] && (
        <Card title="The board says">
          <p className="text-lg">
            <span className="font-semibold text-gain-400">
              {data.board.recommendations[0].player.name}
            </span>{" "}
            <span className="text-chalk-500">
              ({data.board.recommendations[0].player.position})
            </span>
          </p>
          <Reasons reasons={data.board.recommendations[0].reasons} collapsedCount={4} />
        </Card>
      )}

      {data && (
        <Card title={`Best available (pick ${current})`}>
          <ul className="space-y-4">
            {data.board.recommendations.slice(0, 12).map((rec, i) => (
              <li key={rec.player.id} className="flex flex-wrap items-baseline gap-2 border-b border-pitch-800 pb-4 last:border-0">
                <span className="tabular w-6 text-chalk-500">{i + 1}.</span>
                <span className="font-medium">{rec.player.name}</span>
                <span className="text-chalk-500">
                  {rec.player.position} · {rec.player.proTeam} · bye {rec.player.byeWeek}
                </span>
                <span className="tabular ml-auto font-semibold">{rec.score.toFixed(0)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
