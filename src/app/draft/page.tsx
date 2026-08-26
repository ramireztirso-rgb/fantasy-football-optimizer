"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Reasons } from "@/components/Reasons";
import { Card, DemoBanner, ErrorBox, Loading, Pill, Stat } from "@/components/ui";
import type { LeagueSettings, Player, Position } from "@/lib/domain/types";
import type { DraftBoard } from "@/lib/engine/draft";
import type { LiveDraftContext, PositionalRun } from "@/lib/engine/draftLive";
import type { Reason } from "@/lib/engine/explain";

interface LiveDraftResponse {
  isDemo: boolean;
  settings: LeagueSettings;
  draft: {
    connected: boolean;
    type: string;
    inProgress: boolean;
    completed: boolean;
    mySeat: { teamId: number; slot: number } | null;
    currentPick: number;
    myNextPick: number | null;
    myFollowingPick: number | null;
    picksUntilMyTurn: number;
    interveningTeams: number[];
    runs: PositionalRun[];
    recentPicks: Array<{
      pick: { overallPick: number; round: number; teamId: number; playerId: number };
      player: Player | undefined;
      teamName: string;
    }>;
    teams: LiveDraftContext["teams"];
    myRoster: Player[];
  };
  correction: Reason[];
  board: DraftBoard;
}

const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DST"];

export default function DraftPage() {
  const [data, setData] = useState<LiveDraftResponse | null>(null);
  const [error, setError] = useState<{ error: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  // Targets from the previous turn, so the board can report what got sniped.
  const previousTargets = useRef<number[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/draft/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previousTargets: previousTargets.current, limit: 25 }),
      });
      const json = await res.json();
      if (!res.ok) throw json;
      setData(json as LiveDraftResponse);
      setError(null);
      setLastSync(new Date());
    } catch (err) {
      const shaped = err as { error?: string; hint?: string };
      setError({ error: shaped?.error ?? "Could not load the draft board.", hint: shaped?.hint });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a draft is running, picks land every few seconds; outside one there is
  // nothing to poll for.
  useEffect(() => {
    if (!autoRefresh || !data?.draft.inProgress) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [autoRefresh, data?.draft.inProgress, load]);

  if (error) return <ErrorBox {...error} />;
  if (loading || !data) return <Loading what="the draft board" />;

  const { draft, board, settings, correction } = data;
  const onTheClock = draft.myNextPick !== null && draft.picksUntilMyTurn === 0;

  return (
    <div className="space-y-6">
      {data.isDemo && <DemoBanner />}

      <Card
        title="Draft"
        subtitle={
          draft.connected
            ? "Reading picks live from ESPN. The board re-ranks itself as other teams pick."
            : "No draft published for this league yet. The board is ranking on projections and ADP alone."
        }
        right={
          <div className="flex items-center gap-2">
            <Pill tone={draft.inProgress ? "good" : draft.completed ? "neutral" : "warn"}>
              {draft.inProgress ? "Live" : draft.completed ? "Complete" : "Not started"}
            </Pill>
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className="rounded-lg border border-pitch-700 px-2 py-1 text-xs text-chalk-300 hover:bg-pitch-800"
            >
              {autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-pitch-700 px-2 py-1 text-xs text-chalk-300 hover:bg-pitch-800"
            >
              Refresh
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="On the clock" value={`#${draft.currentPick}`} />
          <Stat
            label="Your next pick"
            value={draft.myNextPick === null ? "—" : `#${draft.myNextPick}`}
            tone={onTheClock ? "good" : undefined}
          />
          <Stat
            label="Picks until your turn"
            value={draft.myNextPick === null ? "—" : draft.picksUntilMyTurn}
            tone={draft.picksUntilMyTurn <= 2 ? "good" : undefined}
          />
          <Stat
            label="Your seat"
            value={draft.mySeat ? `${draft.mySeat.slot} of ${settings.size}` : "—"}
          />
        </div>
        {lastSync && (
          <p className="mt-4 text-xs text-chalk-500">
            Last synced {lastSync.toLocaleTimeString()}
            {draft.myFollowingPick !== null && <> · pick after next is #{draft.myFollowingPick}</>}
          </p>
        )}
      </Card>

      {onTheClock && board.recommendations[0] && (
        <Card title="You are on the clock">
          <p className="text-lg">
            Take{" "}
            <span className="font-semibold text-gain-400">{board.recommendations[0].player.name}</span>{" "}
            <span className="text-chalk-500">
              ({board.recommendations[0].player.position}, {board.recommendations[0].player.proTeam})
            </span>
          </p>
          <Reasons reasons={board.recommendations[0].reasons} collapsedCount={4} />
        </Card>
      )}

      {correction.length > 0 && (
        <Card
          title="What changed and what to do about it"
          subtitle="Recomputed from the picks that have actually happened since your last turn."
        >
          <ul className="space-y-3">
            {correction.map((note) => (
              <li key={note.code} className="flex gap-3 text-sm">
                <Pill
                  tone={
                    note.direction === "negative" ? "warn" : note.direction === "positive" ? "good" : "neutral"
                  }
                >
                  {note.label}
                </Pill>
                <span className="text-chalk-300">{note.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card title="Best picks available">
          <ul className="space-y-6">
            {board.recommendations.map((rec, i) => (
              <li key={rec.player.id} className="border-b border-pitch-800 pb-6 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="tabular w-6 text-chalk-500">{i + 1}.</span>
                  <span className="text-base font-medium">{rec.player.name}</span>
                  <span className="text-chalk-500">
                    {rec.player.position} · {rec.player.proTeam}
                  </span>
                  <Pill tone="neutral">Tier {rec.tier}</Pill>
                  <Pill
                    tone={
                      rec.survivalProbability < 0.25
                        ? "bad"
                        : rec.survivalProbability > 0.6
                          ? "good"
                          : "warn"
                    }
                  >
                    {(rec.survivalProbability * 100).toFixed(0)}% lasts
                    {rec.survivalBasis === "league-needs" ? " (league)" : " (ADP)"}
                  </Pill>
                  <span className="tabular ml-auto text-lg font-semibold">{rec.score.toFixed(0)}</span>
                </div>
                <Reasons reasons={rec.reasons} />
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-6">
          {draft.runs.length > 0 && (
            <Card title="Runs in progress">
              <ul className="space-y-2 text-sm">
                {draft.runs.map((run) => (
                  <li key={run.position} className="flex gap-3">
                    <Pill tone="warn">{run.position}</Pill>
                    <span className="text-chalk-300">
                      {run.taken} taken in the last 8 picks — {run.intensity.toFixed(1)}× the normal
                      rate for this league.
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title="Recent picks"
            subtitle={draft.connected ? "Straight from ESPN's draft feed." : "Nothing drafted yet."}
          >
            {draft.recentPicks.length === 0 ? (
              <p className="text-sm text-chalk-500">No picks made yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {draft.recentPicks.map((entry) => (
                  <li key={entry.pick.overallPick} className="flex gap-3">
                    <span className="tabular w-10 shrink-0 text-chalk-500">
                      {entry.pick.overallPick}.
                    </span>
                    <span className="text-chalk-300">
                      <span className="text-chalk-100">{entry.teamName}</span> took{" "}
                      {entry.player ? (
                        <>
                          {entry.player.name}{" "}
                          <span className="text-chalk-500">
                            ({entry.player.position}, {entry.player.proTeam})
                          </span>
                        </>
                      ) : (
                        `player ${entry.pick.playerId}`
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="What the teams ahead of you need"
            subtitle="Only the teams picking between now and your next turn."
          >
            {draft.interveningTeams.length === 0 ? (
              <p className="text-sm text-chalk-500">
                Nobody picks before your next turn.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                      <th className="pb-2 font-medium">Team</th>
                      {POSITIONS.filter((p) => p !== "K" && p !== "DST").map((pos) => (
                        <th key={pos} className="pb-2 text-right font-medium">
                          {pos}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {draft.interveningTeams.map((teamId, i) => {
                      const state = draft.teams.find((t) => t.teamId === teamId);
                      return (
                        <tr key={`${teamId}-${i}`} className="border-b border-pitch-800/60 last:border-0">
                          <td className="py-2 text-chalk-300">{state?.name ?? `Team ${teamId}`}</td>
                          {POSITIONS.filter((p) => p !== "K" && p !== "DST").map((pos) => {
                            const need = state?.need[pos] ?? 0;
                            return (
                              <td
                                key={pos}
                                className={`tabular py-2 text-right ${
                                  need > 0 ? "text-flag-400" : "text-chalk-500"
                                }`}
                              >
                                {need > 0 ? need.toFixed(1) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-chalk-500">
                  Amber means that team still has a starting slot open there, so they are live to
                  take the position before your turn.
                </p>
              </div>
            )}
          </Card>

          {draft.myRoster.length > 0 && (
            <Card title="Your roster so far">
              <ul className="space-y-1 text-sm">
                {draft.myRoster.map((p) => (
                  <li key={p.id} className="text-chalk-300">
                    <span className="text-chalk-500">{p.position}</span> {p.name}{" "}
                    <span className="text-chalk-500">{p.proTeam}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
