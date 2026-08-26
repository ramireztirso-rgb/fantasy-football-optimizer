"use client";

import { useState } from "react";
import type { Reason } from "@/lib/engine/explain";

/**
 * Renders the factor breakdown behind a recommendation.
 *
 * This is the point of the app, so it is a real component rather than a
 * tooltip: each row shows the factor, its signed contribution, and a sentence
 * explaining it in this league's terms. The impacts sum to the score above it,
 * which is what makes the explanation checkable rather than decorative.
 */
export function Reasons({
  reasons,
  collapsedCount = 3,
  unit = "pts",
}: {
  reasons: Reason[];
  collapsedCount?: number;
  unit?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!reasons.length) return null;

  const shown = expanded ? reasons : reasons.slice(0, collapsedCount);
  const hidden = reasons.length - shown.length;

  return (
    <div className="mt-3 space-y-2">
      {shown.map((reason) => (
        <div key={reason.code} className="flex gap-3 text-sm">
          <span
            className={`tabular w-16 shrink-0 text-right font-medium ${
              reason.direction === "positive"
                ? "text-gain-400"
                : reason.direction === "negative"
                  ? "text-loss-400"
                  : "text-chalk-500"
            }`}
          >
            {reason.impact === 0
              ? "—"
              : `${reason.impact > 0 ? "+" : ""}${reason.impact.toFixed(1)}`}
          </span>
          <span className="text-chalk-300">
            <span className="font-medium text-chalk-100">{reason.label}.</span>{" "}
            {reason.detail}
          </span>
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="ml-[4.75rem] text-xs text-chalk-500 underline underline-offset-2 hover:text-chalk-300"
        >
          Show {hidden} more factor{hidden === 1 ? "" : "s"} ({unit})
        </button>
      )}
      {expanded && reasons.length > collapsedCount && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="ml-[4.75rem] text-xs text-chalk-500 underline underline-offset-2 hover:text-chalk-300"
        >
          Show less
        </button>
      )}
    </div>
  );
}
