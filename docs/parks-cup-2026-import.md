# Parks Cup 2026 — Import Retrospective & Direct-Signup Design Notes

Completed 2026-05-09. This is the durable record of what we built to import the
Parks Cup 2026 tournament from a `.xlsx` workbook into CourtHive, the edge cases
we hit, and the design hints those edge cases give for any future direct-signup
feature.

## Final state

- Tournament: `Parks Cup 2026` (`72410e93-4749-4ab9-9e11-91e809ea5b9a`)
- Dates: 2026-05-04 → 2026-07-25
- 7 events: Mens Singles, Womens Singles, Mens Doubles, Womens Doubles,
  Mixed Doubles, Veterans Doubles, Mens Plate (the Plate fills post-first-round)
- 155 individuals, 88 pairs, 9 teams (one per club)
- 165 event entries (singles individuals + doubles pairs)
- 48 seed assignments
- Public draws view shows each player with their club as a subtitle, including
  both partners' clubs side-by-side on doubles pairings — via existing
  courthive-public TEAM detail config + server-side hydration of `teams[]`.

## Starting state

A 10-sheet `.xlsx` workbook from the organiser. 6 event sheets, a Master List,
3 noise sheets. Each event sheet had structured player rows in the tabular
top section, then **free-text pairings and seeds** below in inconsistent
formats. ~263 paid-registration rows, 151 unique people, plus several
edge cases we discovered along the way.

The CourtHive tournament already existed with all 7 events configured but
zero participants.

## Pipeline shape

**Parse → review JSON → apply.** Two-stage with a hand-editable JSON contract
between them. The review JSON is the single source of truth; the apply step
is mechanical.

### `scripts/parks-cup/parse.mjs` (local, no build step)

Reads the workbook, treats Master List as canonical for names, fuzzy-matches
per-event sheets and pairings/seeds against it, falls back to creating
participants from event-sheet rows when Master List is missing them, emits
`parks-cup-2026.review.json`.

Matching strategy (in priority order):

1. Exact match on stripped/lowercased first + last name
2. Alias match using `FIRSTNAME_ALIASES` (e.g. `andy`→`andrew`,
   `sam`→`samuel`) and `SURNAME_ALIASES` (e.g. `queldi-brittan`→`brittan`,
   `healing`→`healey`)
3. Levenshtein ≤ 2 on surname, with first-name aliases matching
4. Substring containment on surname (catches `Queldi-Brittan`→`Brittan`)
5. Levenshtein ≤ 2 on first name with exact surname

Surname-only matching was deliberately removed mid-build after it wrongly
matched `Jimmy Milonas` to `Stephen Milonas` (only Stephen was in Master
List; surname-only collapsed both to him). The fallback "create from event
sheet" path then correctly created Jimmy as a separate participant.

Constants for manual overrides, all confirmed by Jim during the import:

- `MANUAL_SEX` — for participants only in Mixed/Vets where neither partner
  has a known sex (Donna Asplin FEMALE, Martin Kucera MALE, Patrick Daniels
  MALE)
- `MANUAL_ENROLMENTS` — for "event sheet says Registration=No but they ARE
  playing per the pairings" cases (Seb Moore Evans → Mens Doubles)
- `CLUB_CANONICAL` — collapses spelling/case variants to canonical club
  names (used by parser AND `parks-cup-build-teams.ts`)

### `src/scripts/parks-cup-discover.ts`

NestJS standalone command, read-only. Run once on prod **before** parsing
to lock in the sheet→event mapping. Prints every event with
eventId/eventType/gender, and uses keyword + type + gender heuristics to
suggest sheet→event mapping. The user verifies and the parser hard-codes
the IDs in `SHEET_TO_EVENT`.

### `src/scripts/parks-cup-apply.ts`

NestJS standalone command. Reads review JSON, validates each event's
type/gender against the live tournament, takes a backup, builds
deterministic participantIds, builds the participant payloads, calls
`participantGovernor.addParticipants` then `entriesGovernor.addEventEntries`
per event, sets `event.seedAssignments` directly. Idempotent; supports
`--dry-run`.

Sex inference for Mixed pairs: if one partner has a known sex, the other
is inferred as opposite. Refuses to apply when both sides of a Mixed pair
have unknown sex.

Validates pre/post invariants and refuses to save on any unexpected change
to participant counts (per type), event entry counts, seed assignment
counts, or draw definition counts.

### `src/scripts/parks-cup-restore.ts`

Companion rollback. Takes a pre-restore snapshot before clobbering live
state with the supplied backup, so the restore itself is reversible. `--force`
required to actually run.

## Deterministic IDs

Every script uses the same scheme:

```ts
const NAMESPACE = 'parks-cup-2026';
function deterministicId(prefix, key) {
  const h = sha256(`${prefix}:${NAMESPACE}:${key}`);
  return UUID-formatted slice of h;
}
```

Examples:

- `deterministicId('individual', 'p_helen_almond')` — same Helen every run
- `deterministicId('pair', sortedRefs.join(':'))` — same pair regardless of
  which order they were typed in the workbook
- `deterministicId('team', 'St Ann\'s')` — same Team every run

This is what made the iterative scripts (one per fix) safe to re-run: the
participant for "Helen Almond" exists at exactly one ID, no matter which
script asks for her.

## Deployment pattern

For one-off scripts we used a **lightweight pattern** — build locally,
ship the compiled JS straight into the running container:

```bash
# Local
pnpm build

# Push compiled artefact to server /tmp
scp -i ~/.ssh/digital_ocean_ssh \
  build/src/scripts/<script>.js \
  root@144.126.228.64:/tmp/

# Drop it inside the container alongside the existing build
ssh -i ~/.ssh/digital_ocean_ssh root@144.126.228.64 \
  "docker cp /tmp/<script>.js courthive-server:/app/build/src/scripts/<script>.js"

# Run from /app so node_modules resolves correctly
ssh -i ~/.ssh/digital_ocean_ssh root@144.126.228.64 \
  "docker exec -w /app courthive-server node build/src/scripts/<script>.js --dry-run"
```

No image rebuild, no container restart, zero downtime, ~30s end-to-end.
The container already has `node_modules` and env, so the script behaves
exactly as if it had shipped in the image.

The full `docker compose build courthive-server` deploy (per
`PRODUCTION_QUICK_REFERENCE.md §4`) was reserved for permanent code
changes; we never needed it for the import work itself.

## Backups

Every mutation script took a fresh backup to
`/app/backups/parks-cup/tournament-<id>-pre-<phase>-<iso-ts>.json` *before*
any write. Critical ones were also pulled to local disk via `docker cp`
into `competition-factory-server/backups/parks-cup/`:

- `tournament-72410e93-pre-apply-2026-05-06T09-23-13.json` (4.9 KB) — pre-import (empty tournament)
- `tournament-72410e93-pre-build-teams-2026-05-06T17-32-37.json` (474 KB) — full pre-Teams state

Server-side backup files remain in the container until a rebuild; pull any
others you want preserved.

## Iterative fixes (post-bulk-import)

Each of these was a small, narrowly-scoped script with the same safety
mechanisms (backup, invariants, dry-run, restore companion):

- `parks-cup-fix-davis-milonas.ts` — un-paired a TMX-side miscue (Will
  Reeves wrongly paired with Joannah Davis), put Joannah with Stephen
  Milonas instead
- `parks-cup-add-mixed-pairs.ts` — Sean+Kate Mahon and Kisoran Moodley+
  Sarah Brooking (workbook had no pairings for them)
- `parks-cup-build-teams.ts` — created 9 Team participants (one per club),
  populated `individualParticipantIds` from each individual's
  `addresses[0].city`. Includes `MANUAL_CLUB` for Seb Moore Evans →
  St Ann's, Troy Raftery → Preston Park (both clubless in source data)
- `parks-cup-add-alternates.ts` — late alternate registrations (Patricia
  Pollard → Hove, Frederick Holmes → unknown club)

## Critical rules learned

### **No tournament mutations after draws are generated.**

Once draws exist in TMX, even idempotent-looking writes risk disrupting
scheduled matchups, draw structures, seed positions, and entry positions
that the draw now references. From here forward, all data changes go
through TMX UI.

The Teams migration (post-draw) was the explicit exception — narrowly
scoped to additive metadata, gated on a 24-invariant check that asserted
no individuals/pairs/entries/seeds/draws were affected.

### **`participantDetail: 'TEAM'` was already wired.**

courthive-public's `src/components/formatters/participantFormatter.ts:46`
had `participantDetail: 'TEAM'` since long before our work. The renderer
reads `individualParticipant.teams[0].participantName`. With no Team
participants on a tournament, the renderer outputs nothing — which is why
no other tournament showed clubs.

Once we created Team participants, the **server-side** `getEventData`
endpoint started hydrating `teams: [{ participantName, participantId }]`
onto every individual in the response. courthive-public received them
hydrated and rendered them via the existing config. **No frontend deploy
was needed** — the data change alone was sufficient.

### **TMX surfaces invalid factory transitions.**

A pair's `entryStatus: 'WITHDRAWN'` cannot be moved to `UNGROUPED` —
factory rule (`isUngrouped` check) is that PAIR participants can never
have UNGROUPED status; that status is reserved for individuals not yet
paired. TMX's UI shows the transition as available but the factory
returns `INVALID_ENTRY_STATUS`.

## Direct-signup design hints

The pain we absorbed maps almost 1-to-1 to design requirements:

| Pain we hit | Direct-signup hint |
|---|---|
| Master List vs per-event sheets diverged on spellings | Single source of truth — one Person record; event entries reference it |
| Free-text pairings caused 22 fuzzy matches and ambiguous resolutions | Structured pairing — invite-via-token to partner, or both sign as a pair from one form |
| Sex couldn't be inferred for Mixed-only players | Required at signup, never derived |
| Clubs were free text with capitalisation/apostrophe variants | Pick from canonical list; persist to both `addresses[0].city` AND Team membership atomically |
| 12 Mixed registrants with no recorded partner | "Looking for a partner" status as first-class; admin match-making UI |
| Reeves/Davis pair broke on WITHDRAWN→UNGROUPED transition | Don't surface raw factory enums; "withdraw" should dissolve a pair into individuals |
| Seb's `Registration=No` while in pairings | Single state per registration: paying for an event = enrolment |
| Mens Plate is opt-in post-round-1 | Per-event opt-in flag at signup ("If knocked out early, play the Plate?") |
| Late alternates (Patricia, Frederick) | Open alternate window independently; "alternate" badge; auto-promote on withdrawal |
| DOB Excel serial / Mac 1904 / no validation | Date input with picker, validated client-side |
| Mixed Doubles requires M+F | Validate at submit time, refuse same-sex Mixed pair |
| Render path needed Teams | Always create Team membership at signup — render path "just works" for any future tournament |

## Codebase artefacts

In `competition-factory-server/`:

```
scripts/parks-cup/parse.mjs                       Local parser
scripts/parks-cup/parks-cup-2026.review.json      The review file
src/scripts/parks-cup-discover.ts                 Read-only event lookup
src/scripts/parks-cup-apply.ts                    Bulk import
src/scripts/parks-cup-restore.ts                  Rollback companion
src/scripts/parks-cup-fix-davis-milonas.ts        One-off pair fix
src/scripts/parks-cup-add-mixed-pairs.ts          Post-hoc pair adds
src/scripts/parks-cup-build-teams.ts              Teams migration
src/scripts/parks-cup-add-alternates.ts           Alternate signups
backups/parks-cup/                                Local backups (pre-apply, pre-Teams)
```

The `xlsx` package was added as a devDependency for the parser.

## Things to clean up later

- **Address-as-club hack still present** on every individual:
  `person.addresses[0].city = "<club>"`. Harmless (Teams are now the
  canonical source), but redundant. Could be cleaned up in a future
  pass — but only when the tournament is fully closed (no more draws or
  entries) and a backup is taken.
- **Mens Plate is empty** — fills in TMX as players opt in after their
  Mens Singles first-round loss.
- **Some Mixed Doubles registrants are unpaired** (Rosie James, Tom
  Whitehead, Oliver Watkins, Sarah Watkins, Eloise Saville, James
  Bothwell). They're tournament participants ready to be paired and
  enrolled via TMX as partners are confirmed.
