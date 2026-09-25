#!/usr/bin/env node
/**
 * enter-scores.mjs — enter/correct match results in a live tournament via the
 * server's executionQueue (POST /factory) — the same locked + validated + saved
 * + broadcast path TMX uses. No direct tournamentRecord/Postgres JSON writes.
 *
 * Two modes:
 *   --list [eventSubstring]   Print every non-BYE matchUp (id, round, status,
 *                             score, both sides' players). Use this to find the
 *                             matchUpId or the exact player/pair names to put in
 *                             a results file.
 *   --file results.json       Apply the results in the file. Dry-run by default;
 *                             add --apply to write.
 *
 * A results file is a JSON array of entries. Each entry resolves to exactly one
 * matchUp, either by explicit matchUpId or by matching the winner (and optionally
 * loser) name within an event. Score is always WINNER-FIRST.
 *
 *   [
 *     // completed, resolved by name (winner + loser disambiguate the matchUp):
 *     { "event": "Men's Plate", "winner": "James Hartt", "loser": "Edward Obree",
 *       "score": "6-0 4-6 7-5" },
 *
 *     // championship-tiebreak final set — write it bracketed; the format is
 *     // auto-detected as SET3-S:6/TB7-F:TB10:
 *     { "event": "Men's Plate", "winner": "Stefanos Nayar", "loser": "Ben Black",
 *       "score": "6-2 5-7 [10-5]" },
 *
 *     // pairs: match on the pair name or any individual's name:
 *     { "event": "Mixed Doubles", "winner": "Barr/Soldanova",
 *       "loser": "Hutchinson/Ncube", "score": "6-3 3-6 6-4" },
 *
 *     // walkover / retired (no score needed for walkover):
 *     { "matchUpId": "efab08f1-...", "status": "WALKOVER", "winner": "Lewis/Stevens" },
 *     { "event": "Mixed Doubles", "winner": "Arnold/Cosme", "loser": "Webster/Brunner",
 *       "status": "RETIRED", "score": "5-4" },
 *
 *     // explicit overrides (skip auto-detection): "matchUpId", "format",
 *     // "winningSide" (1|2), "force": true (overwrite an already-resolved matchUp).
 *   ]
 *
 * Auth (one of):
 *   COURTHIVE_TOKEN=<jwt>                      # paste from a logged-in TMX session
 *   COURTHIVE_EMAIL=... COURTHIVE_PASSWORD=... # script logs in for a token
 *   COURTHIVE_MINT=1                           # mint a superadmin token locally from
 *                                              # competition-factory-server/.env JWT_SECRET
 *                                              # (local dev convenience only)
 *
 * ALWAYS back up first (project convention for any post-draw write):
 *   ssh -i ~/.ssh/digital_ocean_ssh root@<server> \
 *     "docker exec courthive-postgres pg_dump -U courthive -d courthive --data-only --inserts --table=tournaments" \
 *     > ~/backups/<tournament>-tournaments-preScores-$(date +%Y%m%d-%H%M%S).sql
 *
 * Usage:
 *   node scripts/scores/enter-scores.mjs --tournament <id> --list ["Mixed"]
 *   node scripts/scores/enter-scores.mjs --tournament <id> --file results.json         # dry-run
 *   node scripts/scores/enter-scores.mjs --tournament <id> --file results.json --apply
 */

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mocksEngine } = require('tods-competition-factory');

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
const APPLY = !!args.apply;

if (!TOURNAMENT_ID) {
  console.error('Missing --tournament <tournamentId>.');
  process.exit(2);
}
if (!args.list && !args.file) {
  console.error('Nothing to do. Pass --list [eventSubstring] or --file <results.json>.');
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
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function mintToken() {
  const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  const m = env.match(/^JWT_SECRET=(.*)$/m);
  if (!m) throw new Error('COURTHIVE_MINT set but JWT_SECRET not found in .env');
  const secret = m[1].trim().replace(/^["']|["']$/g, '');
  const iat = Math.floor(Date.now() / 1000);
  const payload = { email: process.env.COURTHIVE_EMAIL || 'jameshartt@gmail.com', roles: ['superadmin'], aud: 'admin', iat, exp: iat + 3600 * 6 };
  const enc = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(enc).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return enc + '.' + sig;
}

async function getToken() {
  if (process.env.COURTHIVE_MINT) return mintToken();
  if (process.env.COURTHIVE_TOKEN) return process.env.COURTHIVE_TOKEN;
  const email = process.env.COURTHIVE_EMAIL;
  const password = process.env.COURTHIVE_PASSWORD;
  if (email && password) {
    const res = await api('/auth/login', { email, password });
    const token = res.accessToken || res.token || res.data?.accessToken;
    if (!token) throw new Error('Login succeeded but no accessToken in response');
    return token;
  }
  console.error('No auth. Set COURTHIVE_TOKEN, or COURTHIVE_EMAIL + COURTHIVE_PASSWORD, or COURTHIVE_MINT=1.');
  process.exit(2);
}

// ---- record helpers -------------------------------------------------------

function indexRecord(rec) {
  const P = Object.fromEntries((rec.participants || []).map((p) => [p.participantId, p]));
  const matchUps = []; // {event, drawId, structureName, m, sideParticipantIds:[pid1,pid2]}
  for (const e of rec.events || []) {
    for (const dd of e.drawDefinitions || []) {
      for (const st of dd.structures || []) {
        const pa = Object.fromEntries((st.positionAssignments || []).map((p) => [p.drawPosition, p.participantId]));
        for (const m of st.matchUps || []) {
          const dps = m.drawPositions || [];
          matchUps.push({
            event: e,
            drawId: dd.drawId,
            structureName: st.structureName || '',
            m,
            sidePids: [pa[dps[0]] || null, pa[dps[1]] || null],
          });
        }
      }
    }
  }
  return { P, matchUps };
}

function nameFor(P, pid) {
  if (!pid) return '—';
  const p = P[pid];
  if (!p) return pid.slice(0, 8);
  if (p.participantType === 'PAIR') {
    const inds = (p.individualParticipantIds || []).map((i) => P[i]?.participantName || i);
    return `${p.participantName} (${inds.join(' + ')})`;
  }
  return p.participantName;
}

// searchable lowercase string for a side (pair name + individual names)
function sideSearchString(P, pid) {
  if (!pid) return '';
  const p = P[pid];
  if (!p) return '';
  let s = (p.participantName || '') + ' ';
  if (p.participantType === 'PAIR') s += (p.individualParticipantIds || []).map((i) => P[i]?.participantName || '').join(' ');
  return s.toLowerCase();
}

function matchesQuery(searchStr, query) {
  if (!query) return false;
  const q = String(query).toLowerCase().trim();
  if (searchStr.includes(q)) return true;
  // all whitespace/slash-separated tokens present
  const tokens = q.split(/[\s/]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => searchStr.includes(t));
}

// ---- list mode ------------------------------------------------------------

function doList(rec, eventSub) {
  const { P, matchUps } = indexRecord(rec);
  const byEvent = new Map();
  for (const mu of matchUps) {
    if (eventSub && !mu.event.eventName.toLowerCase().includes(String(eventSub).toLowerCase())) continue;
    if (mu.m.matchUpStatus === 'BYE') continue;
    if (!byEvent.has(mu.event.eventId)) byEvent.set(mu.event.eventId, { name: mu.event.eventName, rows: [] });
    byEvent.get(mu.event.eventId).rows.push(mu);
  }
  for (const { name, rows } of byEvent.values()) {
    console.log(`\n#### ${name}`);
    rows.sort((a, b) => (a.m.roundNumber - b.m.roundNumber) || (a.m.roundPosition - b.m.roundPosition));
    for (const mu of rows) {
      const m = mu.m;
      const ws = m.winningSide ? `WIN=side${m.winningSide}` : '';
      console.log(`  R${m.roundNumber}.${m.roundPosition} ${m.matchUpId} ${(m.matchUpStatus || '').padEnd(12)} ${ws} ${m.score?.scoreStringSide1 || ''}`);
      console.log(`      side1: ${nameFor(P, mu.sidePids[0])}`);
      console.log(`      side2: ${nameFor(P, mu.sidePids[1])}`);
    }
  }
}

// ---- format detection -----------------------------------------------------

// A bracketed final set like "[10-5]" means the last set was a championship
// tiebreak. Base best-of-3 with a full 3rd set is SET3-S:6/TB7; with a champ
// final-set TB it is SET3-S:6/TB7-F:TB10.
function detectFormat(score) {
  if (!score) return 'SET3-S:6/TB7';
  const sets = score.trim().split(/\s+/);
  const last = sets[sets.length - 1];
  if (/^\[\d+-\d+\]$/.test(last)) return 'SET3-S:6/TB7-F:TB10';
  return 'SET3-S:6/TB7';
}

// ---- apply mode -----------------------------------------------------------

function resolveEntry(entry, idx, index) {
  const { P, matchUps } = index;
  let candidates;
  if (entry.matchUpId) {
    candidates = matchUps.filter((mu) => mu.m.matchUpId === entry.matchUpId);
    if (!candidates.length) throw new Error(`entry[${idx}]: matchUpId ${entry.matchUpId} not found`);
  } else {
    if (!entry.event || !entry.winner) throw new Error(`entry[${idx}]: need matchUpId, or event + winner`);
    candidates = matchUps.filter((mu) => mu.event.eventName.toLowerCase().includes(entry.event.toLowerCase()));
    if (!candidates.length) throw new Error(`entry[${idx}]: no event matching "${entry.event}"`);
    candidates = candidates.filter((mu) => {
      const s1 = sideSearchString(P, mu.sidePids[0]);
      const s2 = sideSearchString(P, mu.sidePids[1]);
      const winnerOnASide = matchesQuery(s1, entry.winner) || matchesQuery(s2, entry.winner);
      if (!winnerOnASide) return false;
      if (entry.loser) return matchesQuery(s1, entry.loser) || matchesQuery(s2, entry.loser);
      return true;
    });
    if (!candidates.length) throw new Error(`entry[${idx}]: no matchUp in "${entry.event}" with winner "${entry.winner}"${entry.loser ? ` vs "${entry.loser}"` : ''}`);
    if (candidates.length > 1) {
      const list = candidates.map((c) => `${c.m.matchUpId} (R${c.m.roundNumber}.${c.m.roundPosition})`).join(', ');
      throw new Error(`entry[${idx}]: ambiguous — ${candidates.length} matchUps match: ${list}. Add "loser" or an explicit "matchUpId".`);
    }
  }
  const mu = candidates[0];

  // winningSide: explicit, else infer from which side the winner is on
  let winningSide = entry.winningSide;
  if (!winningSide) {
    const s1 = sideSearchString(P, mu.sidePids[0]);
    const s2 = sideSearchString(P, mu.sidePids[1]);
    const on1 = matchesQuery(s1, entry.winner);
    const on2 = matchesQuery(s2, entry.winner);
    if (on1 && !on2) winningSide = 1;
    else if (on2 && !on1) winningSide = 2;
    else throw new Error(`entry[${idx}]: could not determine winning side for "${entry.winner}" (matched both/neither). Set "winningSide".`);
  }

  return { mu, winningSide };
}

function buildOutcome(entry, winningSide) {
  const status = (entry.status || 'COMPLETED').toUpperCase();
  if (status === 'WALKOVER') {
    const r = mocksEngine.generateOutcomeFromScoreString({ scoreString: '', winningSide, matchUpStatus: 'WALKOVER' });
    if (r.error) throw new Error('walkover outcome gen failed: ' + JSON.stringify(r.error));
    return { outcome: r.outcome, format: null, status };
  }
  if (!entry.score) throw new Error(`${status} needs a winner-first "score"`);
  const format = entry.format || detectFormat(entry.score);
  const r = mocksEngine.generateOutcomeFromScoreString({ scoreString: entry.score, winningSide, matchUpStatus: status, matchUpFormat: format });
  if (r.error) throw new Error('outcome gen failed: ' + JSON.stringify(r.error));
  return { outcome: r.outcome, format, status };
}

async function doApply(rec, entries, token) {
  const index = indexRecord(rec);
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===');
  let applied = 0, skipped = 0, failed = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let mu, winningSide, built;
    try {
      ({ mu, winningSide } = resolveEntry(entry, i, index));
      built = buildOutcome(entry, winningSide);
    } catch (err) {
      console.log(`\n• entry[${i}] ${entry.winner || entry.matchUpId || ''}`);
      console.log(`  RESOLVE FAILED: ${err.message}`);
      failed++;
      continue;
    }
    const m = mu.m;
    const cur = m.matchUpStatus;
    const isOpen = cur === 'TO_BE_PLAYED' || cur === 'IN_PROGRESS' || !cur;
    const target = built.status === 'WALKOVER'
      ? `WALKOVER ws=${winningSide}`
      : `${built.status} ws=${winningSide} "${built.outcome.score?.scoreStringSide1 || ''}" fmt=${built.format}`;
    console.log(`\n• ${mu.event.eventName} R${m.roundNumber}.${m.roundPosition} — ${entry.winner || ''}`);
    console.log(`  matchUpId=${m.matchUpId} current=${cur}  ->  ${target}`);
    if (!isOpen && !entry.force) { console.log('  SKIP: already resolved (add "force": true to overwrite).'); skipped++; continue; }
    if (!APPLY) { console.log(entry.force && !isOpen ? '  would OVERWRITE.' : '  would write.'); continue; }
    const params = { matchUpId: m.matchUpId, drawId: mu.drawId, outcome: built.outcome, ...(built.format ? { matchUpFormat: built.format } : {}) };
    try {
      const res = await api('/factory', { tournamentId: TOURNAMENT_ID, methods: [{ method: 'setMatchUpStatus', params }] }, token);
      if (res.error || res.success === false) { console.log('  FAILED:', JSON.stringify(res.error || res)); failed++; }
      else { console.log('  APPLIED success=' + res.success); applied++; }
    } catch (err) { console.log('  FAILED:', err.message); failed++; }
  }
  console.log(`\n${APPLY ? 'DONE' : 'DRY RUN'}. ${APPLY ? 'applied' : 'would write'}=${applied} skipped=${skipped} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

// ---- main -----------------------------------------------------------------

(async () => {
  const token = await getToken();
  const fetched = await api('/factory/fetch', { tournamentId: TOURNAMENT_ID }, token);
  const rec = fetched.tournamentRecords?.[TOURNAMENT_ID] || fetched.tournamentRecord || fetched.data?.tournamentRecords?.[TOURNAMENT_ID];
  if (!rec) throw new Error('Could not read tournament record from /factory/fetch response');

  if (args.list) {
    doList(rec, typeof args.list === 'string' ? args.list : undefined);
    return;
  }
  const entries = JSON.parse(readFileSync(args.file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('results file must be a JSON array');
  await doApply(rec, entries, token);
})().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
