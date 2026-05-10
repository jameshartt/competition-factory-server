/**
 * Parks Cup 2026 — workbook → review JSON.
 *
 * Reads the entry-list xlsx and produces parks-cup-2026.review.json. The review
 * file is the single source of truth that the apply step (running on the server)
 * consumes — every Participant created, every event entry, every pair, every
 * seed is in this file. Hand-edit it before applying.
 *
 * Usage:
 *   node scripts/parks-cup/parse.mjs \
 *     --xlsx "/home/jameshartt/Downloads/Parks Cup Entry Lists 2026.xlsx" \
 *     --out  scripts/parks-cup/parks-cup-2026.review.json
 *
 * Defaults to the paths above if flags are omitted.
 */
import xlsx from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_XLSX = '/home/jameshartt/Downloads/Parks Cup Entry Lists 2026.xlsx';
const DEFAULT_OUT = path.resolve('scripts/parks-cup/parks-cup-2026.review.json');

const TOURNAMENT_ID = '72410e93-4749-4ab9-9e11-91e809ea5b9a';
const TOURNAMENT_NAME = 'Parks Cup 2026';

// Sheet → event mapping confirmed via parks-cup-discover.ts on production.
const SHEET_TO_EVENT = {
  'Ladies-09_00 (4)-1': {
    eventId: '362b43c5-722e-472d-82b4-808fd613192b',
    eventName: 'Womens Singles',
    eventType: 'SINGLES',
    gender: 'FEMALE',
    enforceGender: true,
  },
  'Ladies_Doubles-09_00 (2)-1': {
    eventId: 'd6906a11-1016-4350-b0c4-38b63605a2bc',
    eventName: 'Womens Doubles',
    eventType: 'DOUBLES',
    gender: 'FEMALE',
    enforceGender: true,
  },
  'Mens-09_00-1': {
    eventId: '0c1f8074-8d45-45bc-aba7-08cf9e277ec8',
    eventName: 'Mens Singles',
    eventType: 'SINGLES',
    gender: 'MALE',
    enforceGender: true,
  },
  'Mens_Doubles-09_00 (3)-1': {
    eventId: '21b8bc9d-40ca-411b-82be-47af70fcdfb5',
    eventName: 'Mens Doubles',
    eventType: 'DOUBLES',
    gender: 'MALE',
    enforceGender: true,
  },
  'Mixed-06_00 (1)-1': {
    eventId: '266b7836-5bf1-49d2-ba92-d72e9e610a0f',
    eventName: 'Mixed Doubles',
    eventType: 'DOUBLES',
    gender: 'MIXED',
    enforceGender: true,
  },
  'Vets-06_00-1': {
    eventId: '1d3c3500-909c-426d-a902-907e8facc8c8',
    eventName: 'Veterans Doubles',
    eventType: 'DOUBLES',
    gender: 'MIXED',
    enforceGender: false,
  },
};

const MASTER_SHEET = 'Master List '; // trailing space is intentional (matches workbook)

/**
 * Manual sex declarations — for participants who only appear in gender-neutral
 * events (Mixed Doubles, Vets) and can't be inferred from a singles event or a
 * partner of known sex. Without these, the applier refuses to enrol the pair
 * into a gender-enforced Mixed event.
 *
 * Keep these confirmed only — never guess on a paid tournament.
 */
const MANUAL_SEX = {
  p_donna_asplin: 'FEMALE', // confirmed by Jim 2026-05-06
  p_martin_kucera: 'MALE', // confirmed by Jim 2026-05-06
  p_patrick_daniels: 'MALE', // confirmed by Jim 2026-05-06
};

/**
 * Manual enrolment overrides — for cases where the event-sheet row says
 * Registration=No (or the person is missing from the event sheet entirely)
 * but they ARE actually playing because they appear in the pairings list.
 *
 * Each entry documents WHY so the override is auditable on re-run.
 */
const MANUAL_ENROLMENTS = [
  {
    ref: 'p_seb_moore_evans',
    sheetName: 'Mens_Doubles-09_00 (3)-1',
    reason:
      'Confirmed by Jim 2026-05-06: Seb is playing with Ed Newlands. Mens Doubles event-sheet Registration=No was stale.',
  },
];

const COLS = {
  firstName: 0,
  lastName: 1,
  registration: 2,
  club: 3,
  dob: 4,
  email: 5,
  phone: 6,
  emergencyPhone: 7,
  source: 8,
  amount: 9,
  credit: 10,
  paid: 11,
  refunded: 12,
  attended: 13,
};

// Canonical club spellings — keep small, normalise variants for matching only.
const CLUB_CANONICAL = {
  "st ann's": "St Ann's",
  'st anns': "St Ann's",
  'st. anns': "St Ann's",
  hove: 'Hove',
  dyke: 'Dyke',
  queens: 'Queens',
  'king alfred': 'King Alfred',
  saltdean: 'Saltdean',
  'preston park': 'Preston Park',
  'park avenue': 'Park Avenue',
  blakers: 'Blakers',
};

// Surname aliases observed in the workbook free-text vs Master List spellings.
// Used only to nudge fuzzy matching — never overwrites Master List names.
const SURNAME_ALIASES = {
  'reay smith': 'reay smith',
  'reay-smith': 'reay smith',
  'queldi-brittan': 'brittan',
  'queldi brittan': 'brittan',
  'leforeister': 'leforestier',
  'kingston-jones': 'kingston jones',
  'smith-watson': 'smith watson',
  'pearman-wright': 'pearman wright',
  rafety: 'raftery',
  healing: 'healey', // typo observed in pairings
  jones: 'jones',
};

const FIRSTNAME_ALIASES = {
  alex: 'alexandra',
  alexandra: 'alexandra',
  jamie: 'james',
  james: 'james',
  andy: 'andrew',
  andrew: 'andrew',
  alistair: 'alastair',
  alastair: 'alastair',
  edward: 'ed',
  ed: 'ed',
  fred: 'frederick',
  frederick: 'frederick',
  rico: 'ricoveer',
  ricoveer: 'ricoveer',
  sam: 'samuel',
  samuel: 'samuel',
  nick: 'nicholas',
  nicholas: 'nicholas',
  steve: 'steven', // local convention: nobody here is called Steven without also going by Steve
  steven: 'steven',
  // Stephen kept distinct — Stephen Milonas is not Steven.
  ottlie: 'ottilie',
  ottilie: 'ottilie',
};

// ───────── helpers ─────────

function arg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

const norm = (s) => (s ?? '').toString().trim().toLowerCase().replace(/\s+/g, ' ');

const stripPunct = (s) => norm(s).replace(/[.'’`-]/g, ' ').replace(/\s+/g, ' ').trim();

function canonicalClub(raw) {
  const t = (raw ?? '').toString().trim();
  if (!t) return '';
  const key = t.toLowerCase();
  return CLUB_CANONICAL[key] || t;
}

function canonicalSurname(raw) {
  const k = stripPunct(raw);
  return SURNAME_ALIASES[k] || k;
}

function canonicalFirst(raw) {
  const k = stripPunct(raw);
  return FIRSTNAME_ALIASES[k] || k;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function refForName(firstName, lastName) {
  return (
    'p_' +
    stripPunct(firstName).replace(/\s+/g, '_') +
    '_' +
    stripPunct(lastName).replace(/\s+/g, '_')
  );
}

function pairRefForRefs(refA, refB) {
  const sorted = [refA, refB].sort();
  return 'pair_' + sorted[0].replace(/^p_/, '') + '__' + sorted[1].replace(/^p_/, '');
}

// Excel-serial → ISO date. xlsx returns native Date when cellDates:true is set.
function dobToIso(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    if (y < 1920 || y > new Date().getFullYear()) return null;
    return value.toISOString().slice(0, 10);
  }
  // Defensive — if string, try to parse
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    if (y < 1920 || y > new Date().getFullYear()) return null;
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function inferSexFromEvent(sheetExpect) {
  if (sheetExpect.gender === 'MALE') return 'MALE';
  if (sheetExpect.gender === 'FEMALE') return 'FEMALE';
  return null;
}

function cleanPhone(raw) {
  if (!raw) return null;
  const stripped = (raw ?? '').toString().replace(/^\[/, '').replace(/\]$/, '').trim();
  return stripped || null;
}

// ───────── workbook loading ─────────

function loadWorkbook(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`xlsx not found: ${filePath}`);
    process.exit(1);
  }
  return xlsx.readFile(filePath, { cellDates: true });
}

function rowsFromSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.error(`Sheet not found: ${JSON.stringify(sheetName)}`);
    return [];
  }
  return xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
}

function isPlayerRow(row) {
  // Heuristic: a player row has both first AND last name in cols 0/1, and
  // typically has further data in col 2+ (Registration column).
  if (!row || row.length < 2) return false;
  const first = (row[COLS.firstName] ?? '').toString().trim();
  const last = (row[COLS.lastName] ?? '').toString().trim();
  if (!first || !last) return false;
  // A free-text row like "1. Helen Almond" has the whole thing in col 0; col 1 will be empty.
  return true;
}

function rowToPlayer(row, sourceSheet, rowIndex) {
  const firstRaw = (row[COLS.firstName] ?? '').toString();
  const lastRaw = (row[COLS.lastName] ?? '').toString();
  const firstName = firstRaw.trim();
  const lastName = lastRaw.trim();

  return {
    sourceSheet,
    rowIndex,
    firstNameRaw: firstRaw,
    lastNameRaw: lastRaw,
    firstName,
    lastName,
    trimmed: firstRaw !== firstName || lastRaw !== lastName,
    registration: (row[COLS.registration] ?? '').toString().trim(),
    club: canonicalClub(row[COLS.club]),
    clubRaw: (row[COLS.club] ?? '').toString().trim(),
    dob: dobToIso(row[COLS.dob]),
    dobRaw: row[COLS.dob],
    email: (row[COLS.email] ?? '').toString().trim() || null,
    phone: cleanPhone(row[COLS.phone]),
    emergencyPhone: cleanPhone(row[COLS.emergencyPhone]),
    paid: (row[COLS.paid] ?? '').toString().trim().toLowerCase(),
    refunded: (row[COLS.refunded] ?? '').toString().trim().toLowerCase(),
  };
}

// ───────── master list → canonical participants ─────────

function buildParticipants(workbook) {
  const rows = rowsFromSheet(workbook, MASTER_SHEET);
  const players = [];
  const trimmedNames = [];

  // Master List has NO header row.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isPlayerRow(row)) continue;
    const p = rowToPlayer(row, MASTER_SHEET, i + 1);
    if (p.trimmed) trimmedNames.push({ row: i + 1, before: `${p.firstNameRaw}|${p.lastNameRaw}`, after: `${p.firstName}|${p.lastName}` });
    players.push(p);
  }

  const participants = [];
  const refByMatchKey = new Map(); // matchKey → ref
  const refByPlayer = new Map(); // sourceRowIndex → ref

  let dupCount = 0;
  for (const p of players) {
    const matchKey = `${stripPunct(p.firstName)}|${stripPunct(p.lastName)}|${stripPunct(p.club)}`;
    if (refByMatchKey.has(matchKey)) {
      // Duplicate Master List entry — merge by ref.
      dupCount += 1;
      refByPlayer.set(p.rowIndex, refByMatchKey.get(matchKey));
      continue;
    }

    const ref = refForName(p.firstName, p.lastName);
    let dedupedRef = ref;
    let bump = 2;
    while (participants.some((x) => x.ref === dedupedRef)) {
      // Different person, same first+last — dedupe ref by appending a numeric suffix.
      dedupedRef = `${ref}_${bump++}`;
    }

    refByMatchKey.set(matchKey, dedupedRef);
    refByPlayer.set(p.rowIndex, dedupedRef);

    participants.push({
      ref: dedupedRef,
      firstName: p.firstName,
      lastName: p.lastName,
      club: p.club,
      clubRaw: p.clubRaw !== p.club ? p.clubRaw : undefined,
      email: p.email,
      phone: p.phone,
      emergencyPhone: p.emergencyPhone,
      dob: p.dob,
      sex: null, // filled in per-event when matched on a gendered sheet
      sourceSheet: MASTER_SHEET,
      sourceRow: p.rowIndex,
      paid: p.paid === 'yes',
      refunded: p.refunded === 'yes',
    });
  }

  return { participants, refByMatchKey, trimmedNames, dupCount };
}

// ───────── matcher: name → master-list participant ─────────

function buildNameIndex(participants) {
  const index = [];
  for (const p of participants) {
    index.push({
      ref: p.ref,
      first: stripPunct(p.firstName),
      firstAlias: canonicalFirst(p.firstName),
      last: stripPunct(p.lastName),
      lastAlias: canonicalSurname(p.lastName),
      club: stripPunct(p.club),
    });
  }
  return index;
}

function findInIndex(nameIndex, firstRaw, lastRaw, clubHint) {
  const f = stripPunct(firstRaw);
  const fAlias = canonicalFirst(firstRaw);
  const l = stripPunct(lastRaw);
  const lAlias = canonicalSurname(lastRaw);
  const cl = stripPunct(clubHint || '');

  // Exact (with or without club hint)
  const exact = nameIndex.filter((p) => p.first === f && p.last === l);
  if (exact.length === 1) return { ref: exact[0].ref, confidence: 'exact' };
  if (exact.length > 1 && cl) {
    const exactClub = exact.filter((p) => p.club === cl);
    if (exactClub.length === 1) return { ref: exactClub[0].ref, confidence: 'exact' };
  }
  if (exact.length > 1) return { ref: null, confidence: 'unresolved', candidates: exact.map((p) => p.ref) };

  // Alias-based fuzzy
  const aliased = nameIndex.filter((p) => p.firstAlias === fAlias && p.lastAlias === lAlias);
  if (aliased.length === 1) return { ref: aliased[0].ref, confidence: 'fuzzy' };
  if (aliased.length > 1 && cl) {
    const aliasedClub = aliased.filter((p) => p.club === cl);
    if (aliasedClub.length === 1) return { ref: aliasedClub[0].ref, confidence: 'fuzzy' };
  }
  if (aliased.length > 1) return { ref: null, confidence: 'unresolved', candidates: aliased.map((p) => p.ref) };

  // Levenshtein on surname (≤2 edits) AND first-name alias match → fuzzy
  const editClose = nameIndex.filter(
    (p) => levenshtein(p.last, l) <= 2 && p.firstAlias === fAlias,
  );
  if (editClose.length === 1) return { ref: editClose[0].ref, confidence: 'fuzzy' };
  if (editClose.length > 1 && cl) {
    const editClub = editClose.filter((p) => p.club === cl);
    if (editClub.length === 1) return { ref: editClub[0].ref, confidence: 'fuzzy' };
  }

  // Substring containment on surname (covers "Queldi-Brittan" → "Brittan",
  // "Moore Evans" → "Moore"). Only when first-name aliases match too.
  const containment = nameIndex.filter((p) => {
    if (p.firstAlias !== fAlias) return false;
    const long = l.length >= p.last.length ? l : p.last;
    const short = l.length >= p.last.length ? p.last : l;
    return short.length >= 4 && long.includes(short);
  });
  if (containment.length === 1) return { ref: containment[0].ref, confidence: 'fuzzy' };
  if (containment.length > 1 && cl) {
    const cClub = containment.filter((p) => p.club === cl);
    if (cClub.length === 1) return { ref: cClub[0].ref, confidence: 'fuzzy' };
  }

  // Edit distance ≤ 2 on first name AND exact surname (covers "Jane" vs typo'd
  // "Jane" but a Levenshtein-close first-name typo with same surname).
  const firstClose = nameIndex.filter(
    (p) => p.last === l && levenshtein(p.first, f) <= 2 && p.first !== f,
  );
  if (firstClose.length === 1) return { ref: firstClose[0].ref, confidence: 'fuzzy' };

  // No surname-only match — too dangerous (e.g. "Jimmy Milonas" → "Stephen Milonas").
  // Fall through as unresolved with informative candidates.
  return {
    ref: null,
    confidence: 'unresolved',
    candidates: [...new Set([...editClose, ...containment, ...firstClose].map((p) => p.ref))],
  };
}

// ───────── per-sheet parsing ─────────

function parseEventSheet(workbook, sheetName, expect, nameIndex, participants) {
  const rows = rowsFromSheet(workbook, sheetName);
  const playerRows = [];
  const tailRows = [];

  // Skip header row (event sheets all start with 'First name' header).
  let startedTail = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0) {
      // Header row — confirm shape
      if ((row[COLS.firstName] ?? '').toString().trim().toLowerCase() === 'first name') {
        continue;
      }
      // Not a header — treat as data row
    }
    // Once we hit a non-player row, switch into "tail" (pairings/seeds free-text)
    if (!startedTail && isPlayerRow(row)) {
      playerRows.push({ row, rowIndex: i + 1 });
    } else {
      startedTail = true;
      tailRows.push({ row, rowIndex: i + 1 });
    }
  }

  // Reconcile each player row to a Master List participant
  const enrolled = []; // { ref, sheetRow, sheetFirst, sheetLast, sheetClub, confidence }
  const sheetMisses = [];
  for (const { row, rowIndex } of playerRows) {
    const sheetPlayer = rowToPlayer(row, sheetName, rowIndex);

    if (sheetPlayer.registration && sheetPlayer.registration.toLowerCase() !== 'yes') {
      sheetMisses.push({
        rowIndex,
        firstName: sheetPlayer.firstName,
        lastName: sheetPlayer.lastName,
        reason: `registration='${sheetPlayer.registration}' (skipped)`,
      });
      continue;
    }
    if (sheetPlayer.refunded === 'yes') {
      sheetMisses.push({
        rowIndex,
        firstName: sheetPlayer.firstName,
        lastName: sheetPlayer.lastName,
        reason: 'refunded=yes (skipped)',
      });
      continue;
    }

    const m = findInIndex(nameIndex, sheetPlayer.firstName, sheetPlayer.lastName, sheetPlayer.club);
    if (!m.ref) {
      sheetMisses.push({
        rowIndex,
        firstName: sheetPlayer.firstName,
        lastName: sheetPlayer.lastName,
        club: sheetPlayer.club,
        reason: 'no master-list match',
        candidates: m.candidates,
      });
      continue;
    }

    enrolled.push({
      ref: m.ref,
      confidence: m.confidence,
      sheetRow: rowIndex,
      sheetFirst: sheetPlayer.firstName,
      sheetLast: sheetPlayer.lastName,
      sheetClub: sheetPlayer.club,
    });

    // Sex enrichment: if the event has a fixed gender, propagate to participant.
    const sex = inferSexFromEvent(expect);
    if (sex) {
      const p = participants.find((pp) => pp.ref === m.ref);
      if (p) {
        if (p.sex && p.sex !== sex) {
          p.sexConflict = `inferred ${sex} from ${sheetName}, but already ${p.sex}`;
        } else {
          p.sex = sex;
        }
      }
    }
  }

  // Now parse the tail — free-text for pairings (doubles only) and seeds.
  // Strategy:
  //   - join all non-empty cells of each tail row into a single string
  //   - identify section markers (Pairings / Seedings / Seeds)
  //   - lines outside markers depend on event type:
  //       * SINGLES → seed lines (start with number then name)
  //       * DOUBLES → pairing lines if before any "Seed" marker, else seed lines
  const tailLines = tailRows
    .map(({ row, rowIndex }) => ({
      text: row
        .map((c) => (c ?? '').toString().trim())
        .filter(Boolean)
        .join(' ')
        .trim(),
      rowIndex,
    }))
    .filter((l) => l.text);

  const pairingLines = []; // { text, rowIndex }
  const seedLines = []; // { text, rowIndex, seedNumber }
  let inSeeds = expect.eventType === 'SINGLES'; // singles: everything in tail is seeds
  let inPairings = expect.eventType === 'DOUBLES'; // doubles: start in pairings

  for (const { text, rowIndex } of tailLines) {
    const low = text.toLowerCase();
    if (/^seed(s|ings?)?\b/.test(low)) {
      inSeeds = true;
      inPairings = false;
      continue;
    }
    if (/^pairings?\b/.test(low)) {
      inPairings = true;
      inSeeds = false;
      continue;
    }
    const seedMatch = text.match(/^\s*(\d+)\s*[.)]\s*(.+)$/);
    if (seedMatch && (inSeeds || expect.eventType === 'SINGLES')) {
      seedLines.push({
        text,
        rowIndex,
        seedNumber: Number(seedMatch[1]),
        body: seedMatch[2].trim(),
      });
      continue;
    }
    if (inPairings) {
      // Detect a "1." prefix even without a Seeds marker — the workbook sometimes
      // omits the 'Seeds' header and just starts numbering. Use that as a hint.
      const sneakySeed = text.match(/^\s*(\d+)\s*[.)]\s*(.+)$/);
      if (sneakySeed) {
        // Treat as seed line — switch mode
        inSeeds = true;
        inPairings = false;
        seedLines.push({
          text,
          rowIndex,
          seedNumber: Number(sneakySeed[1]),
          body: sneakySeed[2].trim(),
        });
        continue;
      }
      pairingLines.push({ text, rowIndex });
      continue;
    }
    // Anything else → log as warning
  }

  return { sheetMisses, enrolled, pairingLines, seedLines };
}

// ───────── pair resolution ─────────

const PAIR_SPLIT_RE = /\s*(?:&|\band\b|-(?=\s)|\s-\s|\/)\s*/i;

function splitPairText(text) {
  // Try common separators in order of confidence.
  // First strip trailing whitespace, ".", trailing "&", etc.
  const t = text.replace(/\s+/g, ' ').trim();
  // Order matters: "&" / " and " are unambiguous.
  let parts = t.split(/\s*&\s*/);
  if (parts.length === 2) return parts;
  parts = t.split(/\s+and\s+/i);
  if (parts.length === 2) return parts;
  // Hyphen between two name groups (only when surrounded by spaces, OR between
  // two capitalised words like "Almond-Robin" where the right side starts with a known first name).
  // Try " - " then a fallback for "X-Y" where Y looks like a first name.
  parts = t.split(/\s+-\s+/);
  if (parts.length === 2) return parts;
  // last resort: a "X-Y" hyphen where the right side starts with capital letter and is followed by another word
  const m = t.match(/^([A-Za-z' ]+?)-([A-Z][a-z]+ [A-Za-z' -]+)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  return null;
}

function splitNameToFirstLast(name) {
  // "Helen Almond" → ['Helen', 'Almond']; "Alex Beveridge" → ['Alex', 'Beveridge'].
  // Multi-word last names: "Samuel Reay Smith" → ['Samuel', 'Reay Smith'] (treat first
  // token as first name, rest as last — except where a known-first-name override applies).
  const t = name.replace(/\s+/g, ' ').trim();
  if (!t) return [null, null];
  const tokens = t.split(' ');
  if (tokens.length < 2) return [t, ''];
  return [tokens[0], tokens.slice(1).join(' ')];
}

function resolvePairText(text, nameIndex, sheetName) {
  const halves = splitPairText(text);
  if (!halves) {
    return { rawText: text, confidence: 'unresolved', error: 'could not split pair text' };
  }
  const [aRaw, bRaw] = halves;
  const [aFirst, aLast] = splitNameToFirstLast(aRaw);
  const [bFirst, bLast] = splitNameToFirstLast(bRaw);
  if (!aLast || !bLast) {
    return { rawText: text, confidence: 'unresolved', error: 'pair half missing surname', halves: [aRaw, bRaw] };
  }

  const ma = findInIndex(nameIndex, aFirst, aLast);
  const mb = findInIndex(nameIndex, bFirst, bLast);

  const refs = [ma.ref, mb.ref].filter(Boolean);
  if (refs.length < 2) {
    return {
      rawText: text,
      confidence: 'unresolved',
      halves: [aRaw, bRaw],
      a: { firstGuess: aFirst, lastGuess: aLast, ...ma },
      b: { firstGuess: bFirst, lastGuess: bLast, ...mb },
    };
  }
  const confidence = ma.confidence === 'exact' && mb.confidence === 'exact' ? 'exact' : 'fuzzy';
  return {
    rawText: text,
    individuals: [ma.ref, mb.ref],
    confidence,
    a: { firstGuess: aFirst, lastGuess: aLast, ...ma },
    b: { firstGuess: bFirst, lastGuess: bLast, ...mb },
  };
}

// ───────── main ─────────

function main() {
  const xlsxPath = arg('xlsx', DEFAULT_XLSX);
  const outPath = arg('out', DEFAULT_OUT);

  console.log('Loading workbook:', xlsxPath);
  const workbook = loadWorkbook(xlsxPath);
  console.log('Sheets in workbook:', workbook.SheetNames);

  // 1) Master List → canonical participants.
  if (!workbook.SheetNames.includes(MASTER_SHEET)) {
    console.error(`Master List sheet not found. Looked for ${JSON.stringify(MASTER_SHEET)}`);
    process.exit(1);
  }
  const { participants, trimmedNames, dupCount } = buildParticipants(workbook);
  console.log(`Master List → ${participants.length} unique participants (${dupCount} duplicate rows merged, ${trimmedNames.length} names trimmed).`);

  let nameIndex = buildNameIndex(participants);

  // 1b) Pre-pass: any event-sheet row that doesn't match Master List → create
  // a Participant from the event-sheet row and add to participants. Master List
  // remains the preferred source; event-sheet rows fill in known gaps.
  const fallbackCreated = []; // diagnostics
  for (const [sheetName, expect] of Object.entries(SHEET_TO_EVENT)) {
    const rows = rowsFromSheet(workbook, sheetName);
    let startedTail = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i === 0) {
        const head = (row[COLS.firstName] ?? '').toString().trim().toLowerCase();
        if (head === 'first name') continue;
      }
      if (!startedTail && isPlayerRow(row)) {
        const sp = rowToPlayer(row, sheetName, i + 1);
        if (sp.registration && sp.registration.toLowerCase() !== 'yes') continue;
        if (sp.refunded === 'yes') continue;
        const m = findInIndex(nameIndex, sp.firstName, sp.lastName, sp.club);
        if (m.ref) continue;

        // No master-list match → create from event-sheet row
        const sex = inferSexFromEvent(expect);
        const baseRef = refForName(sp.firstName, sp.lastName);
        let dedupedRef = baseRef;
        let bump = 2;
        while (participants.some((x) => x.ref === dedupedRef)) {
          dedupedRef = `${baseRef}_${bump++}`;
        }
        participants.push({
          ref: dedupedRef,
          firstName: sp.firstName,
          lastName: sp.lastName,
          club: sp.club,
          clubRaw: sp.clubRaw !== sp.club ? sp.clubRaw : undefined,
          email: sp.email,
          phone: sp.phone,
          emergencyPhone: sp.emergencyPhone,
          dob: sp.dob,
          sex,
          sourceSheet: sheetName,
          sourceRow: i + 1,
          paid: sp.paid === 'yes',
          refunded: sp.refunded === 'yes',
          fromEventSheetFallback: true,
        });
        fallbackCreated.push({
          ref: dedupedRef,
          firstName: sp.firstName,
          lastName: sp.lastName,
          club: sp.club,
          sheet: sheetName,
        });
        // Refresh the index now so the next event sheet sees this person.
        nameIndex = buildNameIndex(participants);
      } else {
        startedTail = true;
      }
    }
  }
  if (fallbackCreated.length) {
    console.log(`Fallback: created ${fallbackCreated.length} extra participants from event sheets (not in Master List).`);
  }
  // Rebuild index after fallback creates
  nameIndex = buildNameIndex(participants);

  // 2) Each event sheet → enrolments + pair/seed candidate lines.
  const perEvent = [];
  for (const [sheetName, expect] of Object.entries(SHEET_TO_EVENT)) {
    if (!workbook.SheetNames.includes(sheetName)) {
      console.error(`Sheet not found: ${sheetName}`);
      process.exit(1);
    }
    const parsed = parseEventSheet(workbook, sheetName, expect, nameIndex, participants);
    console.log(
      `  ${sheetName.padEnd(30)} → enrolled=${parsed.enrolled.length}, missed=${parsed.sheetMisses.length}, pairingLines=${parsed.pairingLines.length}, seedLines=${parsed.seedLines.length}`,
    );
    perEvent.push({ sheetName, expect, ...parsed });
  }

  // 3) Resolve pair/seed lines into refs.
  const pairs = []; // canonical pair list (deduped across events)
  const pairsByEvent = []; // per-event pair refs in declaration order
  const seedsByEvent = [];
  const unknownPartners = []; // pair halves we couldn't resolve at all
  const fuzzyPairs = [];
  const unresolvedPairs = [];

  for (const eventResult of perEvent) {
    const { sheetName, expect, pairingLines, seedLines, enrolled } = eventResult;
    const eventPairRefs = [];

    if (expect.eventType === 'DOUBLES') {
      for (const line of pairingLines) {
        const r = resolvePairText(line.text, nameIndex, sheetName);
        if (r.confidence === 'unresolved' || !r.individuals) {
          unresolvedPairs.push({ sheetName, line: line.text, detail: r });
          // also collect each half whose ref is missing as unknown partner
          if (r.halves) {
            for (const which of ['a', 'b']) {
              if (!r[which]?.ref) {
                unknownPartners.push({
                  sheetName,
                  rawText: line.text,
                  rawName: which === 'a' ? r.halves[0] : r.halves[1],
                  resolution: 'TODO',
                  createAs: null,
                });
              }
            }
          }
          continue;
        }
        const [refA, refB] = r.individuals;
        const pairRef = pairRefForRefs(refA, refB);
        const existing = pairs.find((p) => p.ref === pairRef);
        if (!existing) {
          const a = participants.find((p) => p.ref === refA);
          const b = participants.find((p) => p.ref === refB);
          pairs.push({
            ref: pairRef,
            individuals: [refA, refB],
            displayName: `${a?.firstName} ${a?.lastName} / ${b?.firstName} ${b?.lastName}`,
            sourceSheet: sheetName,
            rawText: line.text,
            confidence: r.confidence,
            ...(r.confidence !== 'exact' && { match: { a: r.a, b: r.b } }),
          });
        } else if (existing.confidence === 'exact' && r.confidence !== 'exact') {
          // keep existing exact
        } else if (existing.confidence !== 'exact' && r.confidence === 'exact') {
          existing.confidence = 'exact';
          delete existing.match;
        }
        if (r.confidence === 'fuzzy' && !fuzzyPairs.find((fp) => fp.pairRef === pairRef)) {
          fuzzyPairs.push({ pairRef, sheetName, rawText: line.text });
        }
        eventPairRefs.push(pairRef);
      }
    }

    pairsByEvent.push({
      sheetName,
      eventId: expect.eventId,
      eventName: expect.eventName,
      pairRefs: eventPairRefs,
    });

    // Seed resolution: per event, against the right candidate pool
    const eventSeeds = [];
    for (const seed of seedLines) {
      if (expect.eventType === 'SINGLES') {
        // Seed body is just a single person's name
        const [first, last] = splitNameToFirstLast(seed.body);
        const m = findInIndex(nameIndex, first, last);
        eventSeeds.push({
          seedNumber: seed.seedNumber,
          rawText: seed.text,
          ref: m.ref || null,
          confidence: m.confidence,
          ...(m.candidates ? { candidates: m.candidates } : {}),
        });
      } else {
        // Seed body is a pair
        const r = resolvePairText(seed.body, nameIndex, sheetName);
        if (r.individuals) {
          const pairRef = pairRefForRefs(r.individuals[0], r.individuals[1]);
          // Validate that this pair exists in this event's pairings.
          const inEvent = eventPairRefs.includes(pairRef);
          eventSeeds.push({
            seedNumber: seed.seedNumber,
            rawText: seed.text,
            pairRef,
            confidence: inEvent ? r.confidence : 'unresolved',
            ...(inEvent ? {} : { error: 'seed pair not in event pairings — possible new pair or fuzzy match' }),
          });
        } else {
          eventSeeds.push({
            seedNumber: seed.seedNumber,
            rawText: seed.text,
            pairRef: null,
            confidence: 'unresolved',
            detail: r,
          });
        }
      }
    }
    seedsByEvent.push({
      sheetName,
      eventId: expect.eventId,
      eventName: expect.eventName,
      seeds: eventSeeds,
    });
  }

  const warnings = [];

  // 4-pre) Apply MANUAL_SEX declarations.
  for (const [ref, sex] of Object.entries(MANUAL_SEX)) {
    const p = participants.find((pp) => pp.ref === ref);
    if (p) p.sex = sex;
  }

  // 4a) Apply manual enrolment overrides (e.g. Seb Moore Evans whose event-sheet
  // registration is stale — confirmed playing via pairings).
  const appliedOverrides = [];
  for (const override of MANUAL_ENROLMENTS) {
    const event = perEvent.find((e) => e.sheetName === override.sheetName);
    if (!event) {
      warnings.push({ kind: 'manual_override_unknown_sheet', ...override });
      continue;
    }
    if (event.enrolled.some((x) => x.ref === override.ref)) continue; // already enrolled
    const participant = participants.find((p) => p.ref === override.ref);
    if (!participant) {
      warnings.push({ kind: 'manual_override_unknown_ref', ...override });
      continue;
    }
    event.enrolled.push({
      ref: override.ref,
      confidence: 'manual',
      sheetRow: null,
      sheetFirst: participant.firstName,
      sheetLast: participant.lastName,
      sheetClub: participant.club,
      manualOverride: override.reason,
    });
    appliedOverrides.push({ ...override, applied: true });
    const sex = inferSexFromEvent(SHEET_TO_EVENT[override.sheetName]);
    if (sex && !participant.sex) participant.sex = sex;
  }

  // 4b) Compute counts AFTER overrides have been applied.
  const fuzzyParticipantCount = perEvent.reduce(
    (sum, e) => sum + e.enrolled.filter((x) => x.confidence !== 'exact' && x.confidence !== 'manual').length,
    0,
  );
  const totalEnrolments = perEvent.reduce((sum, e) => sum + e.enrolled.length, 0);
  // Misses that are NOT covered by a manual override — those are still real.
  const overriddenSheetRefs = new Set(
    appliedOverrides.map((o) => `${o.sheetName}::${o.ref}`),
  );
  const totalMisses = perEvent.reduce(
    (sum, e) => sum + e.sheetMisses.filter((m) => {
      // If this miss corresponds to a participant we've overridden via MANUAL_ENROLMENTS, don't count it.
      const candidateRef = refForName(m.firstName || '', m.lastName || '');
      return !overriddenSheetRefs.has(`${e.sheetName}::${candidateRef}`);
    }).length,
    0,
  );
  const seedFuzzy = seedsByEvent.reduce(
    (sum, e) => sum + e.seeds.filter((s) => s.confidence !== 'exact').length,
    0,
  );
  const seedUnresolved = seedsByEvent.reduce(
    (sum, e) => sum + e.seeds.filter((s) => s.confidence === 'unresolved').length,
    0,
  );

  // 4c) Validate: every pair member must also be enrolled in that event.
  for (const eventEnrolment of pairsByEvent) {
    if (!eventEnrolment.pairRefs.length) continue;
    const enrolledIndividualRefs = new Set(
      perEvent.find((e) => e.sheetName === eventEnrolment.sheetName)?.enrolled.map((x) => x.ref) || [],
    );
    for (const pairRef of eventEnrolment.pairRefs) {
      const pair = pairs.find((p) => p.ref === pairRef);
      if (!pair) continue;
      for (const indRef of pair.individuals) {
        if (!enrolledIndividualRefs.has(indRef)) {
          const ind = participants.find((p) => p.ref === indRef);
          warnings.push({
            kind: 'pair_member_not_enrolled',
            sheetName: eventEnrolment.sheetName,
            eventName: eventEnrolment.eventName,
            pairRef,
            pairText: pair.rawText,
            unenrolledRef: indRef,
            unenrolledName: `${ind?.firstName} ${ind?.lastName}`,
            note:
              'Pair appears in pairings but this individual is not in the enrolment list (possibly Registration=No on event sheet). Decide before apply.',
          });
        }
      }
    }
  }

  // 5) Build review JSON
  const review = {
    tournamentId: TOURNAMENT_ID,
    tournamentName: TOURNAMENT_NAME,
    generatedAt: new Date().toISOString(),
    workbook: path.resolve(xlsxPath),
    sheetToEvent: SHEET_TO_EVENT,
    rules: {
      entryStatus: 'DIRECT_ACCEPTANCE',
      enforceGenderPerEvent: Object.fromEntries(
        Object.entries(SHEET_TO_EVENT).map(([s, e]) => [s, e.enforceGender]),
      ),
      participantStatus: 'ACTIVE',
    },
    stats: {
      participants: participants.length,
      pairs: pairs.length,
      enrolmentsTotal: totalEnrolments,
      sheetMissesTotal: totalMisses,
      pairsFuzzy: fuzzyPairs.length,
      pairsUnresolved: unresolvedPairs.length,
      unknownPartners: unknownPartners.length,
      seedsTotal: seedsByEvent.reduce((s, e) => s + e.seeds.length, 0),
      seedsFuzzy: seedFuzzy,
      seedsUnresolved: seedUnresolved,
      participantMatchesFuzzy: fuzzyParticipantCount,
      masterListNamesTrimmed: trimmedNames.length,
      warnings: 0, // populated post-build
    },
    diagnostics: {
      trimmedNames,
      duplicateMasterListRows: dupCount,
      participantsFromEventSheetFallback: fallbackCreated,
      sheetMisses: perEvent.flatMap((e) =>
        e.sheetMisses.map((m) => ({ sheet: e.sheetName, ...m })),
      ),
    },
    participants,
    pairs,
    enrolments: perEvent.map((e) => ({
      sheetName: e.sheetName,
      eventId: SHEET_TO_EVENT[e.sheetName].eventId,
      eventName: SHEET_TO_EVENT[e.sheetName].eventName,
      eventType: SHEET_TO_EVENT[e.sheetName].eventType,
      individualRefs: e.enrolled.map((x) => x.ref),
      pairRefs:
        SHEET_TO_EVENT[e.sheetName].eventType === 'DOUBLES'
          ? pairsByEvent.find((pe) => pe.sheetName === e.sheetName)?.pairRefs || []
          : [],
      perRowConfidence: e.enrolled.map((x) => ({
        ref: x.ref,
        confidence: x.confidence,
        sheetRow: x.sheetRow,
        sheetFirst: x.sheetFirst,
        sheetLast: x.sheetLast,
      })),
    })),
    seedAssignments: seedsByEvent,
    unknownPartners,
    unresolvedPairs,
    fuzzyPairs,
    warnings,
  };

  review.stats.warnings = warnings.length;
  fs.writeFileSync(outPath, JSON.stringify(review, null, 2) + '\n');
  console.log();
  console.log(`Review written → ${outPath}`);
  console.log();
  console.log('STATS:');
  for (const [k, v] of Object.entries(review.stats)) {
    console.log(`  ${k.padEnd(30)} ${v}`);
  }
  console.log();
  if (
    review.stats.pairsUnresolved ||
    review.stats.unknownPartners ||
    review.stats.seedsUnresolved ||
    review.stats.sheetMissesTotal
  ) {
    console.log('NOT YET APPLY-READY — open the review JSON and resolve TODOs.');
  } else if (review.stats.pairsFuzzy || review.stats.seedsFuzzy || review.stats.participantMatchesFuzzy) {
    console.log('Review fuzzy matches and confirm before apply.');
  } else {
    console.log('Review JSON looks clean. Eyeball the dry-run before applying.');
  }
}

main();
