# Plate population

`populate-plate.mjs` adds the first-round losers of a source event as **entries**
to a plate (consolation) event. It does **not** generate a draw or seed — that's
done manually in TMX once all source first-round matches resolve.

## Why it's safe to script (post-draw)

Writes go through the server's `executionQueue` (`POST /factory`) — the same
locked + validated + saved + broadcast path TMX uses. No direct `tournamentRecord`
JSON writes. Adding entries to an event touches no existing draw structure.

Still: take a backup first (the project convention for any post-draw write):

```bash
ssh -i ~/.ssh/digital_ocean_ssh root@<server> \
  "docker exec courthive-postgres pg_dump -U courthive -d courthive --data-only --inserts --table=tournaments" \
  > ~/backups/parkscup-tournaments-prePlate-$(date +%Y%m%d-%H%M%S).sql
```

## Usage

```bash
# Auth: paste a JWT from a logged-in TMX session (Network tab → any /socket.io
# request → Request Headers → authorization → copy the eyJ... after "Bearer ")
export COURTHIVE_TOKEN=eyJ...

# Dry-run (default) — prints the losers and the delta to add, writes nothing:
node scripts/plate/populate-plate.mjs \
  --tournament 72410e93-4749-4ab9-9e11-91e809ea5b9a \
  --source-event 0c1f8074-8d45-45bc-aba7-08cf9e277ec8 \
  --plate-event  6cc571a7-9cb9-4588-a959-ba98de721dc2

# Apply:
#   ...same flags... --apply
```

Flags: `--tournament`, `--source-event`, `--plate-event` (required);
`--server` (default `https://jim.tennis/api/courthive`), `--round` (default 1),
`--apply` (default off = dry-run).

Auth alternatives to `COURTHIVE_TOKEN`: set `COURTHIVE_EMAIL` + `COURTHIVE_PASSWORD`
and the script logs in for a token.

## Idempotent / re-runnable

Only adds losers not already entered. If some source first-round matches haven't
been played yet, run it now for the resolved losers, then **re-run after the
remaining matches finish** — it adds just the newcomers. The script reports the
pending matches (by roundPosition) each run.

## Parks Cup 2026 (first use, 2026-06-01)

Mens Singles (`0c1f8074…`) → Mens Plate (`6cc571a7…`): added 30 of 32 first-round
losers. roundPositions 21 & 31 were unplayed — re-run to pick them up. Draw +
seeding done manually in TMX.
