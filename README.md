# Fantasy Football Optimizer

A local web app for an ESPN fantasy football league that helps with the draft,
the waiver wire, and weekly start/sit decisions — and shows its reasoning for
every recommendation instead of handing you a number.

Every score in this app decomposes into weighted factors. When it says start
someone, it tells you the swap is worth 11.2 points and shows you the arithmetic:
`+13.0 projection, −1.8 questionable tag, +0.4 trending up`. The explanation is
the calculation, not prose written next to it.

```
CHANGE +25.9  Deion Carter -> Trey Sutton  (QB)
   +25.9  Net gain: Starting Trey Sutton over Deion Carter in your QB slot is
          worth about 25.9 points this week.
     ---  Replaces an injured starter: Deion Carter is listed out.
     ---  Strictly safer: Trey Sutton's floor (18.2) is above Deion Carter's
          ceiling (6.8), so this is not a close call.
```

## Setup

```bash
npm install
cp .env.example .env.local   # then fill it in, see below
npm run verify               # confirms the ESPN connection before you start
npm run dev                  # http://localhost:3000
```

The app runs entirely on your machine. It makes read-only requests to ESPN and
never writes to your league.

### Finding your league id

It is the `leagueId=` number in your league URL:

```
https://fantasy.espn.com/football/league?leagueId=123456
                                                  ^^^^^^
```

### Finding your cookies (private leagues only)

Public leagues work without this. Private ones need two cookies from a browser
where you are logged into ESPN:

1. Open your ESPN league page.
2. DevTools (`F12`) → **Application** → **Storage** → **Cookies** →
   `https://fantasy.espn.com`.
3. Copy the **values** of `espn_s2` and `SWID` into `.env.local`.

`espn_s2` is long and URL-encoded — paste it exactly, no quotes. `SWID` looks
like `{AAAAAAAA-BBBB-...}`; the braces are optional.

These are account-level session cookies. They stay in `.env.local` (gitignored),
are read only on the server, and are never sent to the browser — which is why
every ESPN call goes through a route handler in `src/app/api` rather than from
the page.

They expire every month or so. When the app starts returning 401s, re-copy them.

**Without any configuration the app runs on generated demo data** so you can see
what it does before hunting for cookies. Demo mode is labelled on every page.

## What it does

### Draft (`/draft`) — connected live to your ESPN draft

Reads picks straight from ESPN's draft feed as they happen. You do not enter
anything: it finds your seat from the published draft order, works out your next
pick in snake order, and re-ranks the whole board every time somebody picks.

The ranking is opportunity cost, not "best player available". The question that
decides a pick is not who is best, it is who will still be there at your next
turn. **National ADP is the wrong tool for that**, because it describes millions
of drafters rather than the eleven people ahead of you. So once connected, the
survival model switches: it reconstructs every rival roster from the pick feed,
works out what each team picking before your turn still needs, and models their
next pick as a draw from their own board. A team that has already taken three
running backs is not taking a fourth, however good he is. ADP stays in as a
prior; league state does the work.

On top of that:

- **Course correction.** Which of your targets got sniped since your last turn,
  which positions the teams ahead of you still need (so you know what will fall
  and what will not), and where your own roster is thin.
- **Run detection.** Measured against your league's own baseline rate rather
  than a fixed threshold — three quarterbacks in eight picks is a run in a
  one-QB league and unremarkable in a superflex.
- **Tier cliffs**, roster need, ADP value, and bye-week pileups.
- Kickers and defenses are held off the board until the final two rounds, since
  the alternative to drafting one is not a worse defense, it is any defense for
  free every week plus a real player with that pick.

If no draft is published yet, the board falls back to projections and ADP and
says so.

### League (`/league`) — your custom rules, and what they cost you

Your scoring settings are not a formatting detail. Six-point passing
touchdowns and half-PPR give you materially different positional scarcity than
the default, and the edge goes to whoever prices that in first.

This page reads every scoring rule your league customized, quantifies each one
against the platform default **multiplied by the per-game volume actually
observed in your league's data**, and says what it implies. It does the same for
your roster shape: a 3WR/2FLEX build in a 12-team league starts ~60 receivers a
week, which pushes WR replacement level far deeper than a generic cheat sheet
assumes.

It also learns **how your league drafts** from its own past drafts — which
positions your leaguemates systematically overpay for, and which managers
reliably reach for a quarterback in the first three rounds.

### Scout (`/scout`) — this week's opponent, simulated

Projected totals tell you who is favored. They do not tell you by how much, and
that is the number that should change your decisions: the same bench player is
the right start at 25% and the wrong start at 80%.

So the matchup is simulated 10,000 times from player-level distributions, with
two modeling choices that matter:

- **Lognormal outcomes**, because fantasy scoring is floored at zero and right
  skewed. A normal distribution puts mass below zero and understates the tail
  that decides close matchups.
- **Correlated players.** Outcomes on the same NFL team move together — a
  quarterback throwing for 350 means his receivers ate, and a shootout means
  your defense did not. Simulating players independently makes every lineup look
  far more predictable than it is and systematically understates the variance of
  a stacked roster.

You get a win probability, a realistic scoring range, blowout risk, positional
edges, their biggest threats by ceiling, holes in their lineup, and an explicit
instruction: play for floor, or play for ceiling.

The same page carries **playoff odds**, simulated over your real remaining
schedule so strength of schedule is priced in. When no remaining schedule is
published it reports nothing rather than percentages — with zero games left every
outcome is already decided, and "100%" would be the current standings wearing a
percent sign.

### Waivers (`/waivers`)

Ranked by **what each player adds to your starting lineup**, computed by re-running
the lineup optimizer with them rostered and taking the difference — not by raw
projected points, which would recommend a 9-point receiver to a team already
starting three better ones.

FAAB bids are priced off the upgrade that survives bye-week neutralization,
so a one-week fill-in is priced as a streaming add rather than an investment.
Kickers and defenses are capped at a minimum bid because there is another one
next week.

The drop list ranks your own roster by what your lineup actually loses without
each player, so a buried backup correctly shows as free to cut.

### Lineup (`/lineup`)

Solves the whole starting lineup at once as a max-weight bipartite matching
(Hungarian algorithm) rather than filling slots greedily. This matters because
of FLEX: putting your two best backs in the RB slots can strand a third back who
was worth more in FLEX than the receiver that would otherwise go there. Greedy
gets that wrong; matching does not.

Projections start from ESPN's own numbers — which already encode your league's
scoring settings — then adjust for availability, recent form regressed toward
baseline, and role change inferred from league-wide roster trends. Floor and
ceiling come from each player's own weekly variance once there is enough of a
game log to measure it.

### Live (`/`)

ESPN has no push API, so a single shared server-side poller diffs consecutive
league snapshots and streams the *changes* over SSE — one poll per interval no
matter how many tabs are open. The interval adapts: ~25s during game windows,
10 minutes otherwise.

The diff is the point. A scoreboard refresh tells you nothing; "your RB2 was
just ruled out, and the best replacement on your bench is worth 6 more points"
is the product. It surfaces injury changes, players hitting the wire, claims by
other managers, projection swings on your roster, lead changes in your matchup,
and standing lineup problems (a starter on bye, a starter ruled out) that keep
re-reporting until you fix them.

## Layout

```
src/
├── lib/espn/        ESPN v3 client, auth, and normalization into domain types
│   ├── client.ts      transport, cookie auth, retry/error mapping (server-only)
│   ├── constants.ts   ESPN's numeric id maps: positions, slots, teams, injuries
│   ├── normalize.ts   raw payloads -> domain model
│   └── league.ts      high-level fetchers
├── lib/domain/      the app's vocabulary; no ESPN ids past this line
├── lib/engine/      pure, testable decision logic
│   ├── explain.ts        ReasonBuilder — scores decompose into their factors
│   ├── projections.ts    weekly projection + floor/ceiling
│   ├── replacement.ts    VORP, tier detection, roster need
│   ├── assignment.ts     Hungarian algorithm
│   ├── lineup.ts         start/sit optimization
│   ├── draft.ts          draft board
│   ├── draftLive.ts      snake math, rival roster modelling, run detection
│   ├── waivers.ts        waiver targets, FAAB bids, drop list
│   ├── scoringProfile.ts what your custom rules do to player value
│   ├── simulate.ts       Monte Carlo matchup + playoff odds
│   ├── scout.ts          opponent report
│   └── tendencies.ts     how your league drafts, from its own history
├── lib/live/        snapshot diffing and the poll loop
├── lib/demo/        deterministic synthetic league
└── app/             pages and route handlers
```

The engine is pure and has no ESPN dependency — it takes domain types and
returns recommendations, which is what makes it testable without a network.

## Commands

```bash
npm run dev         # dev server
npm run build       # production build
npm run verify      # check ESPN connection and print what parsed
npm run readiness   # draft-morning check: every source reachable, caches warm
npm run replay      # replay a full draft through the live path, 1117 checks
npm run sweep       # simulate all 12 draft seats against this league's managers
npm run folkisms    # test 20 pieces of received wisdom, with verdicts
npm run backtest    # Zero RB vs Robust RB on six real draft boards
npm test            # 189 tests
npm run typecheck   # tsc --noEmit
```

## Known limits

- **The ESPN integration has not been exercised against a live league.** It was
  built against ESPN's documented v3 API shape and is covered by fixture-based
  tests that pin the payload parsing, but ESPN's API is undocumented and changes
  between seasons. `npm run verify` exists precisely to confirm the wiring on
  your league and to point at what broke if something has moved. The live draft
  feed in particular has never been watched during a real draft — test it before
  draft day, not on it.
- **Cross-season ADP is deliberately not used.** A player's ADP moves hundreds
  of picks between years, so comparing a 2024 pick against this year's ADP
  measures that player's career, not your league's behaviour. Where same-season
  ADP is unavailable — which is the normal case for past drafts — the league
  tendency analysis falls back to comparing early-round *position mix* against
  the market's, which is stable across seasons. The `Reach` column is blank
  whenever the comparison would have been invalid.
- Historical analysis can only resolve players it can still look up. Coverage is
  reported on the page rather than assumed.
- Auction drafts are read but not modelled; the survival and snake-order logic
  assumes a snake draft. Keeper picks are excluded from tendency analysis.
- Projections are ESPN's, adjusted. There is no independent projection model, no
  strength-of-schedule adjustment for individual players, and no snap-count or
  target-share data.
- Simulation correlations are calibrated by position from published research
  rather than fitted to your league. They are directionally right, not exact.
- The live poller lives in the server process, so events are only collected
  while the app is running.
