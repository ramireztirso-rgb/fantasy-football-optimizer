import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-pitch-700 bg-pitch-900/60 p-5">
      {(title || right) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-chalk-500">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const tones = {
    neutral: "bg-pitch-800 text-chalk-300 border-pitch-700",
    good: "bg-gain-600/15 text-gain-400 border-gain-600/30",
    bad: "bg-loss-600/15 text-loss-400 border-loss-600/30",
    warn: "bg-flag-400/15 text-flag-400 border-flag-400/30",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-chalk-500">{label}</div>
      <div
        className={`tabular mt-1 text-2xl font-semibold ${
          tone === "good" ? "text-gain-400" : tone === "bad" ? "text-loss-400" : "text-chalk-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function ErrorBox({ error, hint }: { error: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-loss-600/40 bg-loss-600/10 p-5">
      <p className="font-medium text-loss-400">{error}</p>
      {hint && <p className="mt-2 text-sm text-chalk-300">{hint}</p>}
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="mb-6 rounded-2xl border border-flag-400/30 bg-flag-400/10 p-4 text-sm">
      <span className="font-medium text-flag-400">Demo data.</span>{" "}
      <span className="text-chalk-300">
        No ESPN league is configured, so these are generated players, not your team. Add{" "}
        <code className="rounded bg-pitch-800 px-1 py-0.5">ESPN_LEAGUE_ID</code> and your cookies to{" "}
        <code className="rounded bg-pitch-800 px-1 py-0.5">.env.local</code> — see the README.
      </span>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="text-sm text-chalk-500">Loading {what}…</p>;
}
