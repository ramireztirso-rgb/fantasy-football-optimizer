import { isConfigured } from "@/lib/data";
import { poller } from "@/lib/live/poller";
import { lineupProblems, type LeagueEvent } from "@/lib/live/events";
import { buildDemoLeague } from "@/lib/demo/league";

export const dynamic = "force-dynamic";

/**
 * Server-sent events feed.
 *
 * SSE rather than websockets: the traffic is strictly one-directional, it
 * reconnects on its own, and it needs no extra server. The browser never talks
 * to ESPN, so the auth cookies stay on this side of the wire.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("status", { connected: true, demo: !isConfigured(), at: new Date().toISOString() });

      let unsubscribe: (() => void) | null = null;
      let demoTimer: ReturnType<typeof setInterval> | null = null;

      if (isConfigured()) {
        // Replay recent history so a reconnecting tab is not blank.
        for (const event of poller.recentEvents(20).reverse()) send("league", event);
        unsubscribe = poller.subscribe((event) => send("league", event));
      } else {
        const { league } = buildDemoLeague();
        for (const event of lineupProblems(league, new Date().toISOString())) send("league", event);
        let i = 0;
        demoTimer = setInterval(() => {
          send("league", demoEvent(i++));
        }, 12_000);
      }

      // Keeps proxies from closing an idle connection, and doubles as a
      // liveness signal for the UI's "connected" indicator.
      const heartbeat = setInterval(() => send("ping", { at: new Date().toISOString() }), 20_000);

      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        if (demoTimer) clearInterval(demoTimer);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disables buffering on proxies that would otherwise hold the stream.
      "x-accel-buffering": "no",
    },
  });
}

/** Cycles through plausible events so the demo feed shows what the real one does. */
function demoEvent(i: number): LeagueEvent {
  const at = new Date().toISOString();
  const samples: Array<Omit<LeagueEvent, "id" | "at">> = [
    {
      kind: "injury_change",
      severity: "critical",
      title: "Demo: your starting RB is now out",
      detail: "A rostered starter moved from questionable to out during warmups.",
      action: "Open the Lineup tab -- the optimizer already has a replacement ranked.",
      mine: true,
    },
    {
      kind: "player_dropped",
      severity: "warning",
      title: "Demo: a 58%-rostered WR hit the wire",
      detail: "Another manager cut a widely rostered receiver.",
      action: "Check the Waivers tab before someone else claims them.",
      mine: false,
    },
    {
      kind: "score_update",
      severity: "info",
      title: "Demo: 78.4 - 71.2",
      detail: "You scored 6.2, your opponent scored 0.0. You are up 7.2.",
      mine: true,
    },
    {
      kind: "matchup_swing",
      severity: "warning",
      title: "Demo: you just lost the lead",
      detail: "Your matchup flipped: you are now behind by 3.1.",
      action: "With players still to play, the high-ceiling option is now the right call.",
      mine: true,
    },
  ];
  const sample = samples[i % samples.length];
  return { ...sample, id: `demo:${i}:${at}`, at };
}
