"use client";

import { Card, DemoBanner, ErrorBox, Loading, Pill, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { LeagueSettings } from "@/lib/domain/types";
import type { ScoutingReport } from "@/lib/engine/scout";
import type { PlayoffOdds, TeamStrength } from "@/lib/engine/simulate";

interface ScoutResponse {
  isDemo: boolean;
  settings: LeagueSettings;
  report: ScoutingReport;
  strengths: TeamStrength[];
  playoffOdds: PlayoffOdds[];
  scheduleKnown: number;
}

export default function ScoutPage() {
  const { data, error, loading } = useApi<ScoutResponse>("/api/scout");

  if (error) return <ErrorBox {...error} />;
  if (loading || !data) return <Loading what="the matchup simulation" />;

  const { report, playoffOdds, strengths } = data;
  const sim = report.simulation;
  const myOdds = playoffOdds.find((o) => o.teamId === report.me.teamId);

  return (
    <div className="space-y-6">
      {data.isDemo && <DemoBanner />}

      <Card
        title={`Week ${report.week}: ${report.me.name} vs ${report.opponent?.name ?? "no opponent"}`}
        subtitle={
          sim
            ? `Win probability from ${sim.iterations.toLocaleString()} simulations of the full matchup, with correlated player outcomes.`
            : "No opponent scheduled this week."
        }
      >
        {sim ? (
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Stat
              label="Win probability"
              value={`${(sim.winProbability * 100).toFixed(0)}%`}
              tone={sim.winProbability >= 0.55 ? "good" : sim.winProbability <= 0.45 ? "bad" : undefined}
            />
            <Stat label="Your projection" value={sim.meanFor.toFixed(1)} />
            <Stat label="Their projection" value={sim.meanAgainst.toFixed(1)} />
            <Stat
              label="Median margin"
              value={`${sim.medianMargin > 0 ? "+" : ""}${sim.medianMargin.toFixed(1)}`}
              tone={sim.medianMargin > 0 ? "good" : "bad"}
            />
          </div>
        ) : (
          <p className="text-sm text-chalk-500">Nothing to simulate this week.</p>
        )}
      </Card>

      <Card
        title="How to play this week"
        subtitle="The same bench player is the right start when you are an underdog and the wrong one when you are favored."
      >
        <ul className="space-y-3">
          {report.strategy.map((note) => (
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Positional edges" subtitle="Your optimal starters against theirs.">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                <th className="pb-2 font-medium">Position</th>
                <th className="pb-2 text-right font-medium">You</th>
                <th className="pb-2 text-right font-medium">Them</th>
                <th className="pb-2 text-right font-medium">Edge</th>
              </tr>
            </thead>
            <tbody>
              {report.edges.map((edge) => (
                <tr key={edge.position} className="border-b border-pitch-800/60 last:border-0">
                  <td className="py-2 text-chalk-300">{edge.position}</td>
                  <td className="tabular py-2 text-right">{edge.myPoints.toFixed(1)}</td>
                  <td className="tabular py-2 text-right text-chalk-500">{edge.theirPoints.toFixed(1)}</td>
                  <td
                    className={`tabular py-2 text-right font-medium ${
                      edge.edge > 0 ? "text-gain-400" : edge.edge < 0 ? "text-loss-400" : "text-chalk-500"
                    }`}
                  >
                    {edge.edge > 0 ? "+" : ""}
                    {edge.edge.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-6">
          {report.threats.length > 0 && (
            <Card title="Their biggest threats" subtitle="Ranked by ceiling, not projection.">
              <ul className="space-y-2 text-sm">
                {report.threats.map(({ player, projection }) => (
                  <li key={player.id} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{player.name}</span>
                    <span className="text-chalk-500">
                      {player.position} · {player.proTeam}
                    </span>
                    <span className="tabular ml-auto text-chalk-300">
                      {projection.points.toFixed(1)} proj, {projection.ceiling.toFixed(1)} ceiling
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {report.theirWeaknesses.length > 0 && (
            <Card title="Holes in their lineup">
              <ul className="space-y-2 text-sm">
                {report.theirWeaknesses.map((w) => (
                  <li key={`${w.slot}-${w.player.id}`} className="flex gap-3">
                    <Pill tone="good">{w.slot}</Pill>
                    <span className="text-chalk-300">{w.detail}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <Card
        title="Playoff odds"
        subtitle={
          data.scheduleKnown > 0
            ? `Simulated over the ${data.scheduleKnown} remaining scheduled matchups, so strength of schedule is priced in.`
            : "No remaining schedule was published, so these reflect current standings only."
        }
        right={myOdds && <Pill tone={myOdds.playoffProbability >= 0.5 ? "good" : "warn"}>
          You: {(myOdds.playoffProbability * 100).toFixed(0)}%
        </Pill>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                <th className="pb-2 font-medium">Team</th>
                <th className="pb-2 text-right font-medium">Weekly avg</th>
                <th className="pb-2 text-right font-medium">Exp. wins</th>
                <th className="pb-2 text-right font-medium">Playoffs</th>
                <th className="pb-2 text-right font-medium">1st seed</th>
              </tr>
            </thead>
            <tbody>
              {playoffOdds.map((odds) => {
                const strength = strengths.find((s) => s.teamId === odds.teamId);
                const mine = odds.teamId === report.me.teamId;
                return (
                  <tr
                    key={odds.teamId}
                    className={`border-b border-pitch-800/60 last:border-0 ${mine ? "bg-pitch-800/40" : ""}`}
                  >
                    <td className={`py-2 ${mine ? "font-medium text-chalk-100" : "text-chalk-300"}`}>
                      {odds.name}
                    </td>
                    <td className="tabular py-2 text-right text-chalk-500">
                      {strength ? strength.mean.toFixed(1) : "—"}
                    </td>
                    <td className="tabular py-2 text-right">{odds.expectedWins.toFixed(1)}</td>
                    <td
                      className={`tabular py-2 text-right font-medium ${
                        odds.playoffProbability >= 0.5 ? "text-gain-400" : "text-chalk-300"
                      }`}
                    >
                      {(odds.playoffProbability * 100).toFixed(0)}%
                    </td>
                    <td className="tabular py-2 text-right text-chalk-500">
                      {(odds.firstSeedProbability * 100).toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
