"use client";

import { useEffect, useRef, useState } from "react";
import type { LeagueEvent } from "@/lib/live/events";
import { Card, Pill } from "./ui";

/**
 * Live event feed backed by the SSE route.
 *
 * `EventSource` handles reconnection on its own, so the only state kept here is
 * the event list and a connected flag. Events are deduped by id because a
 * reconnect replays recent history.
 */
export function LiveFeed({ limit = 25 }: { limit?: number }) {
  const [events, setEvents] = useState<LeagueEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const source = new EventSource("/api/live");

    source.addEventListener("status", () => setConnected(true));
    source.addEventListener("ping", () => setConnected(true));
    source.addEventListener("league", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as LeagueEvent;
        if (seen.current.has(event.id)) return;
        seen.current.add(event.id);
        setEvents((prev) => [event, ...prev].slice(0, limit));
      } catch {
        // A malformed frame should drop that frame, not the stream.
      }
    });
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [limit]);

  return (
    <Card
      title="Live"
      subtitle="Injury news, roster moves, and scoring as they happen."
      right={
        <Pill tone={connected ? "good" : "warn"}>
          {connected ? "Connected" : "Reconnecting…"}
        </Pill>
      }
    >
      {events.length === 0 ? (
        <p className="text-sm text-chalk-500">
          Watching your league. Events appear here the moment something changes — a player ruled
          out, a useful name hitting the wire, or your matchup flipping.
        </p>
      ) : (
        <ul className="space-y-3">
          {events.map((event) => (
            <li
              key={event.id}
              className={`rounded-xl border p-3 ${
                event.severity === "critical"
                  ? "border-loss-600/40 bg-loss-600/10"
                  : event.severity === "warning"
                    ? "border-flag-400/30 bg-flag-400/5"
                    : "border-pitch-700 bg-pitch-800/40"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{event.title}</span>
                <time className="tabular shrink-0 text-xs text-chalk-500">
                  {new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
              </div>
              <p className="mt-1 text-sm text-chalk-300">{event.detail}</p>
              {event.action && (
                <p className="mt-2 text-sm text-chalk-100">
                  <span className="font-medium">Do this: </span>
                  {event.action}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
