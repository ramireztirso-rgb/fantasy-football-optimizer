"use client";

import Link from "next/link";
import { LiveFeed } from "@/components/LiveFeed";
import { Card, DemoBanner, ErrorBox, Loading, Pill, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { LeagueSettings } from "@/lib/domain/types";
import type { LineupResult } from "@/lib/engine/lineup";
import type { WaiverReport } from "@/lib/engine/waivers";

interface LineupResponse {
  isDemo: boolean;
  team: { id: number; name: string };
  settings: LeagueSettings;
  result: LineupResult;
}

interface WaiverResponse {
  report: WaiverReport;
}

export default function Dashboard() {
  const lineup = useApi<LineupResponse>("/api/lineup");
  const waivers = useApi<WaiverResponse>("/api/waivers");

  if (lineup.error) return <ErrorBox {...lineup.error} />;
  if (lineup.loading || !lineup.data) return <Loading what="your league" />;

  const { result, team, settings } = lineup.data;
  const topTarget = waivers.data?.report.targets[0];
  const urgent = result.warnings.length;

  return (
    <div className="space-y-6">
      {lineup.data.isDemo && <DemoBanner />}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card
            title={team.name}
            subtitle={`${settings.name} · week ${result.week} · ${settings.size}-team ${settings.isPPR ? "PPR" : "standard"}`}
          >
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
              <Stat label="Optimal lineup" value={result.optimalPoints.toFixed(1)} />
              <Stat
                label="Left on bench"
                value={result.pointsLeftOnBench > 0 ? `+${result.pointsLeftOnBench.toFixed(1)}` : "0.0"}
                tone={result.pointsLeftOnBench > 0.5 ? "bad" : "good"}
              />
              <Stat label="Lineup problems" value={urgent} tone={urgent ? "bad" : "good"} />
            </div>
          </Card>

          <Card
            title="What to do next"
            subtitle="The shortest path from where your team is to where it should be."
          >
            <ol className="space-y-4 text-sm">
              {result.warnings.slice(0, 3).map((warning, i) => (
                <li key={`${warning.code}-${i}`} className="flex gap-3">
                  <Pill tone="bad">Fix now</Pill>
                  <span className="text-chalk-300">{warning.detail}</span>
                </li>
              ))}

              {result.changes.slice(0, 3).map((change) => (
                <li key={`${change.slot}-${change.benchPlayer.id}`} className="flex gap-3">
                  <Pill tone="good">+{change.gain.toFixed(1)}</Pill>
                  <span className="text-chalk-300">
                    Start <span className="text-chalk-100">{change.benchPlayer.name}</span>
                    {change.startingPlayer && <> over {change.startingPlayer.name}</>} in {change.slot}.{" "}
                    {change.reasons[1]?.detail ?? change.reasons[0]?.detail}
                  </span>
                </li>
              ))}

              {topTarget && (
                <li className="flex gap-3">
                  <Pill tone="good">Waiver</Pill>
                  <span className="text-chalk-300">
                    Claim <span className="text-chalk-100">{topTarget.player.name}</span> (
                    {topTarget.player.position}, {topTarget.player.proTeam})
                    {topTarget.suggestedBid !== undefined && <> for about ${topTarget.suggestedBid}</>}.{" "}
                    {topTarget.reasons[0]?.detail}
                  </span>
                </li>
              )}

              {!urgent && result.changes.length === 0 && !topTarget && (
                <li className="text-gain-400">
                  Nothing needs your attention. Lineup is optimal and the wire has no upgrades.
                </li>
              )}
            </ol>

            <div className="mt-5 flex gap-2 text-sm">
              <Link
                href="/lineup"
                className="rounded-lg border border-pitch-700 px-3 py-2 text-chalk-300 hover:bg-pitch-800"
              >
                Full lineup analysis
              </Link>
              <Link
                href="/waivers"
                className="rounded-lg border border-pitch-700 px-3 py-2 text-chalk-300 hover:bg-pitch-800"
              >
                Waiver targets
              </Link>
              <Link
                href="/draft"
                className="rounded-lg border border-pitch-700 px-3 py-2 text-chalk-300 hover:bg-pitch-800"
              >
                Draft board
              </Link>
            </div>
          </Card>
        </div>

        <LiveFeed />
      </div>
    </div>
  );
}
