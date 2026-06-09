#!/usr/bin/env node
/**
 * populate-plate.mjs — add first-round losers of a source event as ENTRIES to a
 * plate (consolation) event.
 *
 * What it does NOT do: it does not generate a draw or seed anything. Entries are
 * added with entryStatus DIRECT_ACCEPTANCE / entryStage MAIN. The plate draw and
 * seeding are done manually in TMX once all source first-round matches resolve.
 *
 * Safety / design:
 *   - Dry-run by default. Pass --apply to write.
 *   - Idempotent: only adds losers not already entered, so it is safe to re-run
 *     as the remaining first-round matches complete.
 *   - Writes go through the server's executionQueue (POST /factory) — the exact
 *     same locked + validated + saved + broadcast path TMX itself uses. No direct
 *     tournamentRecord JSON writes.
 *
 * Auth (one of):
 *   COURTHIVE_TOKEN=<jwt>                      # paste from a logged-in TMX session
 *   COURTHIVE_EMAIL=... COURTHIVE_PASSWORD=... # script logs in for a token
 *
 * Usage:
 *   node scripts/plate/populate-plate.mjs \
 *     --tournament 72410e93-4749-4ab9-9e11-91e809ea5b9a \
 *     --source-event 0c1f8074-8d45-45bc-aba7-08cf9e277ec8 \
 *     --plate-event  6cc571a7-9cb9-4588-a959-ba98de721dc2 \
 *     [--server https://jim.tennis/api/courthive] [--round 1] [--apply]
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = arr[i + 1];
      acc.push([key, next && !next.startsWith('--') ? next : true]);
    }
    return acc;
  }, []),
);

const SERVER = (args.server || 'https://jim.tennis/api/courthive').replace(/\/$/, '');
const TOURNAMENT_ID = args.tournament;
const SOURCE_EVENT = args['source-event'];
const PLATE_EVENT = args['plate-event'];
const ROUND = Number(args.round || 1);
const APPLY = !!args.apply;

if (!TOURNAMENT_ID || !SOURCE_EVENT || !PLATE_EVENT) {
  console.error('Missing required args. Need --tournament, --source-event, --plate-event.');
  process.exit(2);
}

async function api(path, body, token) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function getToken() {
  if (process.env.COURTHIVE_TOKEN) return process.env.COURTHIVE_TOKEN;
  const email = process.env.COURTHIVE_EMAIL;
  const password = process.env.COURTHIVE_PASSWORD;
  if (!email || !password) {
    console.error('No auth. Set COURTHIVE_TOKEN, or COURTHIVE_EMAIL + COURTHIVE_PASSWORD.');
    process.exit(2);
  }
  const res = await api('/auth/login', { email, password });
  const token = res.accessToken || res.token || res.data?.accessToken;
  if (!token) throw new Error('Login succeeded but no accessToken in response');
  return token;
}

function computeRoundLosers(record) {
  const src = (record.events || []).find((e) => e.eventId === SOURCE_EVENT);
  if (!src) throw new Error(`Source event ${SOURCE_EVENT} not found`);
  const dd = (src.drawDefinitions || [])[0];
  if (!dd) throw new Error('Source event has no draw definition');
  // MAIN, lowest stageSequence (the real first-round structure)
  const mains = (dd.structures || []).filter((s) => s.stage === 'MAIN');
  const st = mains.sort((a, b) => (a.stageSequence || 1) - (b.stageSequence || 1))[0];
  if (!st) throw new Error('No MAIN structure in source draw');
  const pa = Object.fromEntries((st.positionAssignments || []).map((p) => [p.drawPosition, p.participantId]));
  const roundMatchUps = (st.matchUps || []).filter((m) => m.roundNumber === ROUND);

  const losers = [];
  const pending = [];
  for (const m of roundMatchUps) {
    const dps = m.drawPositions || [];
    const ws = m.winningSide;
    if (ws !== 1 && ws !== 2) { pending.push(m.roundPosition); continue; }
    if (dps.length !== 2) continue;
    const loserDp = ws === 1 ? dps[1] : dps[0];
    const pid = pa[loserDp];
    if (pid) losers.push(pid); // null pid = bye position, skip
  }
  return { losers, pending, total: roundMatchUps.length };
}

function existingPlateEntries(record) {
  const plate = (record.events || []).find((e) => e.eventId === PLATE_EVENT);
  if (!plate) throw new Error(`Plate event ${PLATE_EVENT} not found`);
  return new Set((plate.entries || []).map((e) => e.participantId));
}

(async () => {
  const token = await getToken();

  const fetched = await api('/factory/fetch', { tournamentId: TOURNAMENT_ID }, token);
  const record = fetched.tournamentRecords?.[TOURNAMENT_ID] || fetched.tournamentRecord || fetched.data?.tournamentRecords?.[TOURNAMENT_ID];
  if (!record) throw new Error('Could not read tournament record from /factory/fetch response');

  const names = Object.fromEntries((record.participants || []).map((p) => [p.participantId, p.participantName]));
  const { losers, pending, total } = computeRoundLosers(record);
  const already = existingPlateEntries(record);
  const toAdd = losers.filter((pid) => !already.has(pid));

  console.log(`Source round ${ROUND}: ${total} matchUps`);
  console.log(`  resolved losers : ${losers.length}`);
  console.log(`  pending matches : ${pending.length}${pending.length ? ` (roundPositions ${pending.join(', ')} — re-run after these resolve)` : ''}`);
  console.log(`  already entered : ${losers.length - toAdd.length}`);
  console.log(`  to add now      : ${toAdd.length}`);
  toAdd.forEach((pid) => console.log(`    + ${names[pid] || pid}`));

  // --audit: report both directions of discrepancy and stop (read-only).
  // Catches the "result entered backwards then corrected" case — a plate entry
  // who is no longer a first-round loser won't be auto-removed by this script
  // (it only adds), so surface it for a manual swap in TMX.
  if (args.audit) {
    const loserSet = new Set(losers);
    const wronglyEntered = [...already].filter((pid) => !loserSet.has(pid));
    console.log('\n=== AUDIT ===');
    console.log(`  in plate but NOT a current R1 loser (needs manual removal/swap): ${wronglyEntered.length}`);
    wronglyEntered.forEach((pid) => console.log(`    ! ${names[pid] || pid}`));
    console.log(`  resolved losers missing from plate: ${toAdd.length}`);
    toAdd.forEach((pid) => console.log(`    - ${names[pid] || pid}`));
    const clean = !wronglyEntered.length && !toAdd.length;
    console.log(`\n  RESULT: ${clean ? 'CLEAN — plate matches resolved R1 losers' : 'DISCREPANCIES above (note: intentional withdrawals will show as missing)'}`);
    return;
  }

  if (!toAdd.length) {
    console.log('\nNothing to add. Plate entries already up to date for resolved losers.');
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes written. Re-run with --apply to add these entries.');
    return;
  }

  const methods = [
    {
      method: 'addEventEntries',
      params: { eventId: PLATE_EVENT, participantIds: toAdd, entryStatus: 'DIRECT_ACCEPTANCE', entryStage: 'MAIN' },
    },
  ];
  const result = await api('/factory', { tournamentId: TOURNAMENT_ID, methods }, token);
  if (result.error) throw new Error(`executionQueue error: ${JSON.stringify(result.error)}`);
  console.log(`\nAPPLIED — added ${toAdd.length} entries to the plate event. success=${result.success}`);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
