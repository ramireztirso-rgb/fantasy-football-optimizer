"use client";

import { Card, DemoBanner, ErrorBox, Loading, Pill } from "@/components/ui";
import { useApi } from "@/components/useApi";
import type { LeagueSettings } from "@/lib/domain/types";
import type { ScoringProfile } from "@/lib/engine/scoringProfile";
import type { DraftTendencies } from "@/lib/engine/tendencies";

interface ProfileResponse {
  isDemo: boolean;
  settings: LeagueSettings;
  profile: ScoringProfile;
}

interface TendencyResponse {
  isDemo: boolean;
  tendencies: DraftTendencies;
}

export default function LeaguePage() {
  const profile = useApi<ProfileResponse>("/api/profile");
  const tendencies = useApi<TendencyResponse>("/api/tendencies");

  if (profile.error) return <ErrorBox {...profile.error} />;
  if (profile.loading || !profile.data) return <Loading what="your league settings" />;

  const { profile: p, settings } = profile.data;
  const t = tendencies.data?.tendencies;

  return (
    <div className="space-y-6">
      {profile.data.isDemo && <DemoBanner />}

      <Card title="Your league" subtitle={p.summary}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-chalk-500">Starting lineup</h3>
            <ul className="mt-2 space-y-1 text-sm text-chalk-300">
              {settings.lineupSlots.map((slot) => (
                <li key={slot.slot}>
                  {slot.count} × {slot.slot}
                </li>
              ))}
              <li className="text-chalk-500">
                {settings.benchSlots} bench
                {settings.irSlots > 0 && ` · ${settings.irSlots} IR`}
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-chalk-500">Format</h3>
            <ul className="mt-2 space-y-1 text-sm text-chalk-300">
              <li>{settings.size} teams</li>
              <li>
                {settings.pointsPerReception > 0
                  ? `${settings.pointsPerReception} point${settings.pointsPerReception === 1 ? "" : "s"} per reception`
                  : "No PPR"}
              </li>
              <li>
                {settings.usesFaab
                  ? `FAAB, $${settings.faabBudget ?? "?"} budget`
                  : "Waiver priority"}
              </li>
              <li>
                {settings.regularSeasonWeeks}-week season · {settings.playoffTeamCount} playoff teams
              </li>
              <li className="text-chalk-500">{settings.scoringRules.length} scoring rules parsed</li>
            </ul>
          </div>
        </div>
      </Card>

      <Card
        title="What your custom rules do to player value"
        subtitle="Measured against the platform default and multiplied by the per-game volume actually observed in your league."
      >
        {p.isStandard ? (
          <p className="text-sm text-chalk-500">
            Nothing in this league departs meaningfully from ESPN&apos;s default rules, so standard
            rankings apply without adjustment.
          </p>
        ) : (
          <>
            {p.deviations.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                      <th className="pb-2 font-medium">Rule</th>
                      <th className="pb-2 text-right font-medium">Yours</th>
                      <th className="pb-2 text-right font-medium">Standard</th>
                      <th className="pb-2 text-right font-medium">Pts/game</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.deviations.map((d) => (
                      <tr key={d.statId} className="border-b border-pitch-800/60 last:border-0">
                        <td className="py-2 text-chalk-300">
                          {d.label} <span className="text-chalk-500">({d.position})</span>
                        </td>
                        <td className="tabular py-2 text-right">{d.leaguePoints}</td>
                        <td className="tabular py-2 text-right text-chalk-500">{d.standardPoints}</td>
                        <td
                          className={`tabular py-2 text-right font-medium ${
                            d.perGameImpact > 0 ? "text-gain-400" : "text-loss-400"
                          }`}
                        >
                          {d.perGameImpact > 0 ? "+" : ""}
                          {d.perGameImpact.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {p.implications.length > 0 && (
              <ul className="mt-5 space-y-3 text-sm">
                {p.implications.map((line, i) => (
                  <li key={i} className="flex gap-3">
                    <Pill tone="neutral">Implication</Pill>
                    <span className="text-chalk-300">{line}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card
        title="How your league drafts"
        subtitle="Learned from your own past drafts. National ADP describes millions of drafters; this describes the eleven you play against."
      >
        {tendencies.loading ? (
          <Loading what="past drafts" />
        ) : tendencies.error ? (
          <p className="text-sm text-chalk-500">
            Could not read past drafts: {tendencies.error.error}
          </p>
        ) : !t ? null : (
          <>
            <p className="text-sm text-chalk-500">
              {t.seasonsAnalyzed.length > 0
                ? `${t.seasonsAnalyzed.length} season${t.seasonsAnalyzed.length === 1 ? "" : "s"} analyzed (${t.seasonsAnalyzed.join(", ")}) · ${t.totalPicks} picks · ${(t.coverage * 100).toFixed(0)}% of drafted players resolved`
                : "No completed drafts were found for this league."}
            </p>

            {t.insights.length > 0 && (
              <ul className="mt-4 space-y-3 text-sm">
                {t.insights.map((line, i) => (
                  <li key={i} className="flex gap-3">
                    <Pill tone="warn">Edge</Pill>
                    <span className="text-chalk-300">{line}</span>
                  </li>
                ))}
              </ul>
            )}

            {t.positions.length > 0 && (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-pitch-700 text-left text-xs uppercase tracking-wide text-chalk-500">
                      <th className="pb-2 font-medium">Position</th>
                      <th className="pb-2 text-right font-medium">Avg pick here</th>
                      <th className="pb-2 text-right font-medium">Early share</th>
                      <th className="pb-2 text-right font-medium">Market</th>
                      <th className="pb-2 text-right font-medium">Bias</th>
                      <th className="pb-2 text-right font-medium">Reach</th>
                      <th className="pb-2 text-right font-medium">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.positions.map((pos) => (
                      <tr key={pos.position} className="border-b border-pitch-800/60 last:border-0">
                        <td className="py-2 text-chalk-300">{pos.position}</td>
                        <td className="tabular py-2 text-right">{pos.leagueMeanPick.toFixed(0)}</td>
                        <td className="tabular py-2 text-right">
                          {(pos.earlyShare * 100).toFixed(0)}%
                        </td>
                        <td className="tabular py-2 text-right text-chalk-500">
                          {pos.marketEarlyShare === null
                            ? "—"
                            : `${(pos.marketEarlyShare * 100).toFixed(0)}%`}
                        </td>
                        <td
                          className={`tabular py-2 text-right font-medium ${
                            pos.earlyBias === null
                              ? "text-chalk-500"
                              : pos.earlyBias > 0.02
                                ? "text-loss-400"
                                : pos.earlyBias < -0.02
                                  ? "text-gain-400"
                                  : "text-chalk-500"
                          }`}
                        >
                          {pos.earlyBias === null
                            ? "—"
                            : `${pos.earlyBias > 0 ? "+" : ""}${(pos.earlyBias * 100).toFixed(0)}%`}
                        </td>
                        <td className="tabular py-2 text-right text-chalk-500">
                          {pos.reachPicks === null
                            ? "—"
                            : `${pos.reachPicks > 0 ? "+" : ""}${pos.reachPicks.toFixed(0)}`}
                        </td>
                        <td className="tabular py-2 text-right text-chalk-500">{pos.sample}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-chalk-500">
                  <strong className="text-chalk-300">Bias</strong> compares how much of this
                  league&apos;s first three rounds go to a position against how much the market
                  spends over the same span. Red means they overpay there — let them, and take the
                  value falling elsewhere. This holds across seasons.{" "}
                  <strong className="text-chalk-300">Reach</strong> is a pick-by-pick ADP
                  comparison and is only shown when same-season ADP was available
                  {t.adpComparable ? "" : " — it was not, for these drafts"}.
                </p>
              </div>
            )}

            {t.managers.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs uppercase tracking-wide text-chalk-500">Manager tendencies</h3>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {t.managers.map((m) => (
                    <li key={m.teamId} className="flex items-baseline gap-2 text-sm">
                      <span className="text-chalk-300">{m.name}</span>
                      <span className="text-chalk-500">— {m.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
