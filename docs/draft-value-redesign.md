# Why the board keeps preferring running backs, and how to fix it properly

Written after three failed attempts. The point of writing it down is to stop
guessing.

## What's actually wrong

The board ranks players by **value over replacement**: how many more points a
player scores than a freely available one at the same position. That number
drives everything.

Two things are wrong with how it's used.

### Problem 1: the "freely available player" keeps changing

Right now the board works out "the freely available running back" by looking at
who's *still undrafted*. So it recalculates every pick, against a shrinking
group.

That would be fine if every position emptied at the same rate. They don't:

| | freely-available RB | freely-available WR |
|---|---|---|
| pick 1 | 186 points | 186 points |
| pick 48 | **96 points** | 143 points |

Roughly the same number of each position got drafted. But the running back pool
runs out of decent players much faster — after about the 30th back, the drop-off
is roughly twice as steep as it is for receivers. So the bar for "a back you
could get for free" collapses, and every remaining back looks like a bargain by
comparison.

That's not real scarcity. It's an artifact of measuring against a moving target.
It's why every group of "equally valuable" players mid-draft comes back all
running backs.

### Problem 2: every roster adjustment is a percentage

"You already have enough running backs" is applied as *a percentage of the
player's value*. So is "you still need a receiver."

That causes two failures:

- **When the value is negative, penalties become rewards.** A player 144 points
  below the bar was getting a +129 bonus for being at a position we were already
  full at. Fixed now, but it should never have been possible.
- **When the value is near zero, the adjustments vanish too.** Try to fix
  problem 1 by flooring value at zero and the penalties floor with it, so
  nothing stops the board hoarding. That's the six-quarterback result.

The percentages inherit whatever is wrong with the underlying number. They can't
be tuned out of it.

## The fix: measure what a player actually adds to your starting lineup

Stop asking "how good is this player." Ask **"how many more points would my
starting lineup score if I took him?"**

Concretely, for each available player:

1. Take your current roster and work out the best legal starting lineup it can
   field. Any slot you can't fill yet counts as filled by a freely available
   player, because that's genuinely what you'd be starting.
2. Do the same with the candidate added.
3. The difference is his value.

That's it. The answer comes out in points, not percentages.

### Why this fixes both problems at once

- **A sixth running back scores about zero**, because he doesn't crack the
  lineup. No penalty needed — the number is just small. The percentage-based
  saturation rule can be deleted rather than retuned.
- **An empty kicker slot is worth exactly what a kicker adds to it.** The
  awkward special-casing of kickers and defences mostly goes away.
- **Positions are directly comparable**, because everything is measured in the
  same thing: points added to *your* lineup.
- **The value can never go negative.** Adding a player can't make your best
  lineup worse, so the sign bug becomes impossible rather than fixed.
- **The moving-target problem disappears**, because the baseline is only used to
  fill slots you haven't filled yet, not to grade the player.

### What still needs handling

**Bench players would score zero, and that's too harsh.** A backup running back
is real insurance — starters get hurt and have bye weeks. So add a small,
explicit points value for depth: roughly what he'd contribute in the weeks your
starter is out, which is a few games a season, shrinking for each backup you
already have. In points, stated plainly, not as a percentage of anything.

**Early picks need care.** At pick one your lineup is empty, so *every* slot is
a hole and the numbers will be large across the board. That's correct, but it
means the comparison early on is mostly "which position has the biggest gap
between a star and a freely available player" — which is the right question, and
is what value over replacement was always trying to approximate.

**Cost.** This works out a best-lineup twice per candidate player, per pick.
That's about 500 small assignment problems each turn. The machinery already
exists (`maxValueAssignment`, used by the lineup optimiser), and the problems
are tiny — nine slots against about fifteen players. Should be quick enough; if
it isn't, only the top ~80 candidates need it.

## How to know if it worked

Three checks, in order:

1. `npm run sweep` must not score below **2042**. That's the current best.
2. Groups of "equally valuable" players at a mid-draft pick must **mix
   positions**. That's the symptom this is meant to cure, and it's the one the
   sweep can't see.
3. `npm run replay` must still produce a legal roster on every seed.

If check 1 passes but check 2 doesn't, the redesign didn't address the actual
complaint and shouldn't ship on the score alone.

## What I got wrong three times

Worth recording so it doesn't happen a fourth.

1. **Made the baseline static, saw tight ends explode, concluded static was
   wrong.** It wasn't. A separate bug (penalties flipping to bonuses on
   below-average players) was being hidden by the moving baseline, and static
   exposed it.
2. **Made the baseline static again with kicker handling.** Fixed kickers, but
   the same hidden bug was still there.
3. **Floored the value at zero.** Right idea, but the percentage-based
   adjustments floored along with it, so nothing held the board back.

The pattern: all three were attempts to fix the *input* to a formula whose
*shape* was the problem. Percentages of a distorted number stay distorted.

---

## Update after building a prototype: the design above is incomplete

Built it, ran it, and it found a hole in its own reasoning. Recording that here
rather than in a commit nobody will find.

At the first pick it behaves exactly as hoped — a healthy mix of positions:

```
RB  Jahmyr Gibbs        174.3
WR  Puka Nacua          161.7
RB  Bijan Robinson      156.3
RB  Jonathan Taylor     139.7
WR  Ja'Marr Chase       138.6
```

At pick 48 it wants to draft a **defence in the fourth round**:

```
RB  Quinshon Judkins     51.7
DST Broncos D/ST         36.6
DST Texans D/ST          36.4
QB  Jalen Hurts          35.7
```

It isn't wrong on its own terms. Your defence slot is empty, and a top defence
really does add about 36 points over a freely available one. The mistake is in
what it compares against.

**"A freely available player right now" is the wrong alternative.** Nobody
filling a defence slot in round four is choosing between a good defence and a
terrible one. They're choosing between a good defence *now* and an almost-as-good
defence *in round fifteen* — and the second one costs them nothing, because the
good defences are still there in round fifteen.

So the missing term is time. The value of taking a player now is:

> what he adds to my lineup **minus** what I'd add by filling that slot with my
> next pick instead

For a defence, those two are nearly identical, so the difference is close to
zero and it correctly drops down the board. For a running back in a run, the
player available at your next pick is much worse, so the difference is large and
he correctly rises.

This is the same idea the board already has as "will he still be there at my
next turn," which is currently bolted on as a separate adjustment. Under this
design it isn't a separate adjustment at all — it's the definition of value.

**What to do next:** rework `marginalValue` to take the pool and the next pick
number, and compare against the best replacement it can expect to still get for
that slot, rather than against a freely available player. The existing survival
probability already estimates who'll still be there.

The prototype is committed and tested but **is not wired into the board**, and
should not be until this term exists. As it stands it would draft a defence in
the fourth round, which fails the acceptance test more obviously than the
problem it was built to solve.
