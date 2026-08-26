"use client";

import { Reasons } from "@/components/Reasons";
import { Card, DemoBanner, ErrorBox, Loading, Pill, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { LeagueSettings } from "@/lib/domain/types";
import type { LineupResult } from "@/lib/engine/lineup";

interface LineupResponse {
  isDemo: boolean;
  team: { id: number; name: string };
  settings: LeagueSettings;
  result: LineupResult;
}

export default function LineupPage() {
  const { data, error, loading } = useApi<LineupResponse>("/api/lineup");

  if (error) return <ErrorBox {...error} />;
  if (loading || !data) return <Loading what="your lineup" />;

  const { result, settings, team } = data;

  return (
    <div className="space-y-6">
      {data.isDemo && <DemoBanner />}

      <Card
        title={`${team.name} — week ${result.week}`}
        subtitle="Optimal start/sit, solved across every slot at once rather than one slot at a time."
      >
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Stat label="Current lineup" value={result.currentPoints.toFixed(1)} />
          <Stat label="Optimal lineup" value={result.optimalPoints.toFixed(1)} />
          <Stat
            label="Left on bench"
            value={result.pointsLeftOnBench > 0 ? `+${result.pointsLeftOnBench.toFixed(1)}` : "0.0"}
            tone={result.pointsLeftOnBench > 0.5 ? "bad" : "good"}
          />
        </div>
        {result.pointsLeftOnBench <= 0.5 && result.changes.length === 0 && (
          <p className="mt-4 text-sm text-gain-400">
            Your lineup is already optimal for this week. Nothing to change.
          </p>
        )}
      </Card>

      {result.warnings.length > 0 && (
        <Card title="Problems with your current lineup">
          <ul className="space-y-2">
            {result.warnings.map((warning, i) => (
              <li key={`${warning.code}-${i}`} className="flex gap-3 text-sm">
                <Pill tone="bad">{warning.label}</Pill>
                <span className="text-chalk-300">{warning.detail}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {result.changes.length > 0 && (
        <Card
          title="Recommended changes"
          subtitle="Ordered by points gained. Each one shows the arithmetic behind it."
        >
          <ul className="space-y-5">
            {result.changes.map((change) => (
              <li
                key={`${change.slot}-${change.benchPlayer.id}`}
                className="border-b border-pitch-800 pb-5 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <Pill tone="good">+{change.gain.toFixed(1)}</Pill>
                  <span className="font-medium">
                    Start {change.benchPlayer.name}{" "}
                    <span className="text-chalk-500">
                      ({change.benchPlayer.position}, {change.benchPlayer.proTeam})
                    </span>
                  </span>
                  {change.startingPlayer && (
                    <span className="text-chalk-500">
                      over {change.startingPlayer.name} ({change.startingPlayer.position},{" "}
                      {change.startingPlayer.proTeam})
                    </span>
                  )}
                  <span className="text-chalk-500">in {change.slot}</span>
                </div>
                <Reasons reasons={change.reasons} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Optimal lineup"
        subtitle={`${settings.name} · ${settings.isPPR ? `${settings.pointsPerReception} PPR` : "standard scoring"}`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                <th className="pb-2 font-medium">Slot</th>
                <th className="pb-2 font-medium">Player</th>
                <th className="pb-2 text-right font-medium">Floor</th>
                <th className="pb-2 text-right font-medium">Proj</th>
                <th className="pb-2 text-right font-medium">Ceiling</th>
              </tr>
            </thead>
            <tbody>
              {result.optimal.map((assignment, i) => (
                <tr key={`${assignment.slot}-${i}`} className="border-b border-pitch-800/60 last:border-0">
                  <td className="py-2 text-chalk-500">{assignment.slot}</td>
                  <td className="py-2">
                    {assignment.projection ? (
                      <>
                        {assignment.projection.player.name}{" "}
                        <span className="text-chalk-500">
                          {assignment.projection.player.position} · {assignment.projection.player.proTeam}
                        </span>
                        {assignment.projection.player.injuryStatus && (
                          <span className="ml-2 text-xs text-flag-400">
                            {assignment.projection.player.injuryStatus.replace(/_/g, " ").toLowerCase()}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-chalk-500">— no eligible player —</span>
                    )}
                  </td>
                  <td className="tabular py-2 text-right text-chalk-500">
                    {assignment.projection?.floor.toFixed(1) ?? "—"}
                  </td>
                  <td className="tabular py-2 text-right font-medium">
                    {assignment.projection?.points.toFixed(1) ?? "—"}
                  </td>
                  <td className="tabular py-2 text-right text-chalk-500">
                    {assignment.projection?.ceiling.toFixed(1) ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
