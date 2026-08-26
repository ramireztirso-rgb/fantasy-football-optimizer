import "server-only";
import { fetchFreeAgents, fetchScoreboard } from "@/lib/espn/league";
import { credentialsFromEnv } from "@/lib/espn/client";
import { diffSnapshots, lineupProblems, type LeagueEvent, type LeagueSnapshot } from "./events";

/**
 * Server-side poll loop.
 *
 * ESPN offers no websocket or webhook, so "real time" here means a single
 * shared poller that all connected browsers subscribe to. Sharing it matters:
 * one poller means one request per interval regardless of how many tabs are
 * open, which keeps us well clear of ESPN's rate limiting.
 *
 * The interval adapts to whether NFL games are actually being played -- polling
 * every 20 seconds at 3am Wednesday would be pure waste.
 */

type Subscriber = (event: LeagueEvent) => void;

const MAX_HISTORY = 200;

class LivePoller {
  private snapshot: LeagueSnapshot | null = null;
  private subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private history: LeagueEvent[] = [];
  private seen = new Set<string>();
  private polling = false;
  private lastError: string | null = null;

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    this.ensureRunning();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Events observed so far this process, newest first. */
  recentEvents(limit = 50): LeagueEvent[] {
    return this.history.slice(0, limit);
  }

  currentSnapshot(): LeagueSnapshot | null {
    return this.snapshot;
  }

  status() {
    return {
      running: this.timer !== null,
      subscribers: this.subscribers.size,
      lastPollAt: this.snapshot?.takenAt ?? null,
      nextPollInMs: this.pollIntervalMs(),
      lastError: this.lastError,
      eventCount: this.history.length,
    };
  }

  private ensureRunning() {
    if (this.timer === null) this.scheduleNext(0);
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const creds = credentialsFromEnv();
      const league = await fetchScoreboard(creds);
      // The free-agent pool is only needed to spot adds and drops, which do not
      // happen during live games, so it is refreshed on the slower cadence.
      const needFreeAgents = !this.snapshot || !isGameTime();
      const freeAgentIds = needFreeAgents
        ? (await fetchFreeAgents(creds, league.settings.currentWeek, 200)).map((p) => p.id)
        : (this.snapshot?.freeAgentIds ?? []);

      const next: LeagueSnapshot = {
        takenAt: new Date().toISOString(),
        league,
        freeAgentIds,
      };

      const events = this.snapshot ? diffSnapshots(this.snapshot, next) : [];
      // Standing problems are re-derived rather than diffed, so a lineup that is
      // still broken keeps surfacing until it is fixed.
      const problems = lineupProblems(league, next.takenAt);

      this.snapshot = next;
      this.lastError = null;
      for (const event of [...events, ...problems]) this.emit(event);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.polling = false;
      if (this.subscribers.size > 0) this.scheduleNext(this.pollIntervalMs());
      else this.stop();
    }
  }

  private emit(event: LeagueEvent) {
    // Dedupe by id so a still-broken lineup does not spam the feed every poll.
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    this.history.unshift(event);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // A dead subscriber must not take down the poll loop.
      }
    }
  }

  private pollIntervalMs(): number {
    const override = Number(process.env.POLL_INTERVAL_SECONDS);
    if (Number.isFinite(override) && override > 0) return override * 1000;
    return isGameTime() ? 25_000 : 10 * 60_000;
  }
}

/**
 * Rough NFL game windows in US Eastern time: Thursday and Sunday/Monday
 * evenings plus the Sunday afternoon slate. Being generous here costs one extra
 * poll; being too narrow costs live updates during a game.
 */
export function isGameTime(now = new Date()): boolean {
  // getUTC* keeps this independent of the server's local timezone.
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  // Eastern is UTC-5 (or -4 in DST); games run roughly 13:00-23:59 ET,
  // which is 17:00 UTC through 05:00 UTC the following day.
  const inEveningWindow = utcHour >= 17 || utcHour < 5;
  if (!inEveningWindow) return false;
  // Sunday(0)/Monday(1) evenings and their UTC spillover, plus Thursday(4)/Friday(5).
  return [0, 1, 2, 4, 5].includes(utcDay);
}

// A module-level singleton survives across route invocations in the same
// server process, which is what makes one shared poll loop possible.
const globalRef = globalThis as unknown as { __ffPoller?: LivePoller };
export const poller: LivePoller = (globalRef.__ffPoller ??= new LivePoller());
