# Score entry

`enter-scores.mjs` enters or corrects match results in a live tournament from a
small JSON file, resolving each result to a matchUp **by player name** so you
rarely have to hunt for matchUp IDs.

## Why it's safe to script (post-draw)

Writes go through the server's `executionQueue` (`POST /factory`) — the same
locked + validated + saved + broadcast path TMX itself uses. No direct
`tournamentRecord` / Postgres JSON writes. Each result is one `setMatchUpStatus`.

**Always back up first** (project convention for any post-draw write):

```bash
ssh -i ~/.ssh/digital_ocean_ssh root@144.126.228.64 \
  "docker exec courthive-postgres pg_dump -U courthive -d courthive --data-only --inserts --table=tournaments" \
  > ~/backups/clubchamps-tournaments-preScores-$(date +%Y%m%d-%H%M%S).sql
```

## Auth (one of)

```bash
export COURTHIVE_TOKEN=eyJ...            # paste a JWT from a logged-in TMX session
# or
export COURTHIVE_EMAIL=... COURTHIVE_PASSWORD=...   # script logs in for a token
# or (local dev only) mint a superadmin token from competition-factory-server/.env:
export COURTHIVE_MINT=1
```

`COURTHIVE_MINT=1` reads `JWT_SECRET` from `../../.env` and signs a short-lived
`superadmin` token. The `.env` secret equals the prod secret, so it authenticates
against `https://jim.tennis` — use it only from this repo on a trusted machine.

## 1. Find your matches (`--list`)

```bash
node scripts/scores/enter-scores.mjs \
  --tournament 8d71892e-6b28-4a8a-9485-2ca76ad504fb --list "Mixed"
```

Prints every non-BYE matchUp with its id, round, status, current score, and both
sides' players. Omit the substring to list all events. Use it to get the exact
player/pair names (and, if you need them, matchUp IDs) for the results file.

## 2. Write a results file

A JSON array. Each entry resolves to exactly one matchUp — by `matchUpId`, or by
`event` + `winner` (add `loser` when a name appears in more than one open match).
**Score is always winner-first.**

```json
[
  { "event": "Men's Plate", "winner": "James Hartt", "loser": "Edward Obree",
    "score": "6-0 4-6 7-5" },

  { "event": "Men's Plate", "winner": "Stefanos Nayar", "loser": "Ben Black",
    "score": "6-2 5-7 [10-5]" },

  { "event": "Mixed Doubles", "winner": "Barr/Soldanova", "loser": "Hutchinson/Ncube",
    "score": "6-3 3-6 6-4" },

  { "event": "Gentlemens Doubles", "winner": "Lewis/Stevens", "loser": "Ayland/Moore-Evans",
    "status": "WALKOVER" }
]
```

- **Names** match on a player's name or a pair name, or any individual in a pair
  (`"Barr/Soldanova"`, `"Ludka Soldanova"`, and `"Soldanova"` all work). Matching
  is case-insensitive; slash/space-separated tokens must all appear.
- **Championship-tiebreak final set** — write it bracketed, e.g. `... [10-5]`.
  The format is auto-detected as `SET3-S:6/TB7-F:TB10` (renders as `[10-5]`).
  A full third set (e.g. `6-4`) stays `SET3-S:6/TB7`.
- **Walkover** — `"status": "WALKOVER"`, no score needed. **Retired** —
  `"status": "RETIRED"` with the score at retirement.
- **Overrides** — `"matchUpId"`, `"format"`, `"winningSide"` (1|2), and
  `"force": true` (overwrite an already-resolved matchUp, e.g. a correction).

## 3. Dry-run, then apply

```bash
# Dry-run (default): resolves every entry, shows the target matchUp + orientation,
# writes nothing. Already-resolved matchUps show SKIP (use "force" to overwrite).
node scripts/scores/enter-scores.mjs \
  --tournament 8d71892e-6b28-4a8a-9485-2ca76ad504fb --file results.json

# Apply:
node scripts/scores/enter-scores.mjs \
  --tournament 8d71892e-6b28-4a8a-9485-2ca76ad504fb --file results.json --apply
```

The dry-run prints, per entry, the resolved `matchUpId`, current status, and the
`winningSide` + winner-first score + detected format it would write. **Read it**
before `--apply` — confirm each resolved to the match you meant and the winner is
on the right side. Re-run `--list` afterwards to eyeball the stored scores.

Flags: `--tournament` (required); `--list [eventSubstring]` or `--file <json>`
(one required); `--server` (default `https://jim.tennis/api/courthive`);
`--apply` (default off = dry-run).

## Gotchas learned the hard way

- **Score is winner-first**, set by set. `4-6 6-2 6-4` means the winner *lost*
  the first set. Get the order wrong and you record a nonsensical/backwards
  result — the dry-run's `side1`/`side2` lines are there to catch this.
- **Ambiguous names** (same player in two unplayed matches, or only a first name
  given) fail loudly asking for a `loser` or explicit `matchUpId` — they are
  never guessed.
- **Corrections** to an already-entered result need `"force": true`; without it
  the entry is skipped so you can't clobber a result by accident.
- This tournament: `8d71892e-6b28-4a8a-9485-2ca76ad504fb` (St Ann's Club
  Championship). Events: Gentlemens/Ladies Singles, Gentlemens/Ladies/Mixed
  Doubles, Men's Plate.
