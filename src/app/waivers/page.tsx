"use client";

import { Reasons } from "@/components/Reasons";
import { Card, DemoBanner, ErrorBox, Loading, Pill, Stat } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { LeagueSettings } from "@/lib/domain/types";
import type { WaiverReport } from "@/lib/engine/waivers";

interface WaiverResponse {
  isDemo: boolean;
  team: { id: number; name: string };
  settings: LeagueSettings;
  report: WaiverReport;
}

export default function WaiversPage() {
  const { data, error, loading } = useApi<WaiverResponse>("/api/waivers");

  if (error) return <ErrorBox {...error} />;
  if (loading || !data) return <Loading what="the waiver wire" />;

  const { report, settings } = data;

  return (
    <div className="space-y-6">
      {data.isDemo && <DemoBanner />}

      <Card
        title="Waiver wire"
        subtitle="Ranked by what each player adds to your starting lineup, not by raw projected points."
      >
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Stat label="Week" value={report.week} />
          <Stat label="Weeks left" value={report.weeksRemaining} />
          <Stat
            label={settings.usesFaab ? "FAAB left" : "Waiver order"}
            value={settings.usesFaab ? `$${report.faabRemaining ?? "—"}` : "—"}
          />
        </div>
      </Card>

      <Card title="Top targets">
        {report.targets.length === 0 ? (
          <p className="text-sm text-chalk-500">
            Nothing on the wire improves your team right now. That is a real answer — spending a
            claim on a player who cannot crack your lineup costs you the roster spot for nothing.
          </p>
        ) : (
          <ul className="space-y-6">
            {report.targets.map((target) => (
              <li key={target.player.id} className="border-b border-pitch-800 pb-6 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-base font-medium">{target.player.name}</span>
                  <span className="text-chalk-500">
                    {target.player.position} · {target.player.proTeam} · {target.player.percentOwned.toFixed(0)}% rostered
                  </span>
                  {target.suggestedBidPercent > 0 && (
                    <Pill tone="good">
                      Bid {target.suggestedBid !== undefined ? `$${target.suggestedBid}` : `${target.suggestedBidPercent}%`}
                    </Pill>
                  )}
                  {target.lineupUpgrade > 0 && (
                    <Pill tone="good">+{target.lineupUpgrade.toFixed(1)} to your lineup</Pill>
                  )}
                  {target.competition > 0.6 && <Pill tone="warn">Contested</Pill>}
                  {target.player.injuryStatus && (
                    <Pill tone="bad">{target.player.injuryStatus.replace(/_/g, " ").toLowerCase()}</Pill>
                  )}
                </div>

                <Reasons reasons={target.reasons} />

                {target.dropCandidates.length > 0 && (
                  <div className="mt-3 text-sm text-chalk-500">
                    <span className="font-medium text-chalk-300">Drop for them: </span>
                    {target.dropCandidates
                      .map((c) => `${c.player.name} (${c.player.position})`)
                      .join(", ")}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Most expendable on your roster"
        subtitle="Cost to drop is what your optimal lineup actually loses — a buried backup costs nothing."
      >
        <ul className="space-y-3">
          {report.dropList.map((candidate) => (
            <li key={candidate.player.id} className="flex flex-wrap items-baseline gap-2 text-sm">
              <Pill tone={candidate.costToDrop > 0 ? "warn" : "neutral"}>
                −{candidate.costToDrop.toFixed(1)}
              </Pill>
              <span className="font-medium">{candidate.player.name}</span>
              <span className="text-chalk-500">
                {candidate.player.position} · {candidate.player.proTeam}
              </span>
              <span className="text-chalk-300">{candidate.reason}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
