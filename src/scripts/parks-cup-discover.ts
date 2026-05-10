/**
 * Read-only discovery script for the Parks Cup 2026 import.
 *
 * Loads the live tournament, lists every event with eventId / eventType / gender /
 * matchUpType / current entry counts, and proposes a sheet→event mapping based on
 * the spreadsheet sheet names. Run BEFORE parsing the workbook so we lock in the
 * event IDs and catch any surprises (wrong gender on Vets, missing event, etc.).
 *
 * Usage (production):
 *   docker compose exec app node build/src/scripts/parks-cup-discover.js
 *
 * Optional override:
 *   docker compose exec app node build/src/scripts/parks-cup-discover.js \
 *     --tournament-id <uuid>
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../modules/app/app.module';
import { TournamentStorageService } from '../storage/tournament-storage.service';

const DEFAULT_TOURNAMENT_ID = '72410e93-4749-4ab9-9e11-91e809ea5b9a';

type SheetExpectation = {
  sheet: string;
  expectType: 'SINGLES' | 'DOUBLES';
  expectGender: 'MALE' | 'FEMALE' | 'MIXED' | 'ANY' | null;
  keywords: string[];
};

const SHEET_EXPECTATIONS: SheetExpectation[] = [
  { sheet: 'Ladies-09_00 (4)-1', expectType: 'SINGLES', expectGender: 'FEMALE', keywords: ['ladies', 'women', "women's"] },
  { sheet: 'Ladies_Doubles-09_00 (2)-1', expectType: 'DOUBLES', expectGender: 'FEMALE', keywords: ['ladies', 'women', "women's"] },
  { sheet: 'Mens-09_00-1', expectType: 'SINGLES', expectGender: 'MALE', keywords: ['mens', 'men', "men's"] },
  { sheet: 'Mens_Doubles-09_00 (3)-1', expectType: 'DOUBLES', expectGender: 'MALE', keywords: ['mens', 'men', "men's"] },
  { sheet: 'Mixed-06_00 (1)-1', expectType: 'DOUBLES', expectGender: 'MIXED', keywords: ['mixed'] },
  { sheet: 'Vets-06_00-1', expectType: 'DOUBLES', expectGender: null, keywords: ['vet', 'senior', 'masters'] },
];

function parseArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function pad(s: string | number | undefined, len: number): string {
  const v = (s ?? '').toString();
  return v.length >= len ? v.slice(0, len) : v + ' '.repeat(len - v.length);
}

async function main() {
  const tournamentId = parseArg('tournament-id') || DEFAULT_TOURNAMENT_ID;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const storage = app.get(TournamentStorageService);
    const result = (await storage.findTournamentRecord({ tournamentId })) as {
      tournamentRecord?: any;
      error?: any;
    };

    if (result.error || !result.tournamentRecord) {
      console.error('FAILED to load tournament:', result.error || 'not found');
      process.exitCode = 1;
      return;
    }

    const tournamentRecord = result.tournamentRecord;
    const events: any[] = tournamentRecord.events || [];
    const participants: any[] = tournamentRecord.participants || [];

    console.log('TOURNAMENT');
    console.log('  id              :', tournamentRecord.tournamentId);
    console.log('  name            :', tournamentRecord.tournamentName || '(no name)');
    console.log('  start           :', tournamentRecord.startDate || '-');
    console.log('  end             :', tournamentRecord.endDate || '-');
    console.log('  status          :', tournamentRecord.tournamentStatus || '-');
    console.log('  events          :', events.length);
    console.log('  participants    :', participants.length);
    console.log();

    if (!events.length) {
      console.error('No events configured on this tournament. Cannot import.');
      process.exitCode = 1;
      return;
    }

    console.log('EVENTS:');
    console.log(
      '  ' +
        pad('eventId', 38) +
        ' | ' +
        pad('eventName', 30) +
        ' | ' +
        pad('eventType', 9) +
        ' | ' +
        pad('gender', 7) +
        ' | ' +
        pad('matchUpType', 11) +
        ' | entries',
    );
    console.log(
      '  ' +
        '-'.repeat(38) +
        '-+-' +
        '-'.repeat(30) +
        '-+-' +
        '-'.repeat(9) +
        '-+-' +
        '-'.repeat(7) +
        '-+-' +
        '-'.repeat(11) +
        '-+--------',
    );
    for (const event of events) {
      console.log(
        '  ' +
          pad(event.eventId, 38) +
          ' | ' +
          pad(event.eventName, 30) +
          ' | ' +
          pad(event.eventType, 9) +
          ' | ' +
          pad(event.gender, 7) +
          ' | ' +
          pad(event.matchUpType, 11) +
          ' | ' +
          ((event.entries || []).length).toString(),
      );
    }
    console.log();

    console.log('SUGGESTED SHEET → EVENT MAPPING:');
    console.log('  Verify each row before we lock the mapping into the parser.');
    console.log();

    const ambiguous: string[] = [];
    const unmatched: string[] = [];

    for (const sheetMap of SHEET_EXPECTATIONS) {
      const candidates = events.filter((e: any) => {
        const name = (e.eventName || '').toLowerCase();
        const typeMatches = e.eventType === sheetMap.expectType;
        const genderMatches =
          sheetMap.expectGender === null || e.gender === sheetMap.expectGender || e.gender === 'ANY';
        const nameMatches = sheetMap.keywords.some((k) => name.includes(k));
        return typeMatches && genderMatches && nameMatches;
      });

      const expectedDesc = `${sheetMap.expectType}/${sheetMap.expectGender ?? 'ANY'}`;

      if (candidates.length === 1) {
        const c = candidates[0];
        console.log(
          `  [OK] ${pad(sheetMap.sheet, 28)} → ${c.eventId}  "${c.eventName}"  [${c.eventType}/${c.gender}]  expected=${expectedDesc}`,
        );
      } else if (candidates.length === 0) {
        console.log(
          `  [!!] ${pad(sheetMap.sheet, 28)} → NO EVENT MATCHED  expected=${expectedDesc}`,
        );
        unmatched.push(sheetMap.sheet);
      } else {
        console.log(
          `  [??] ${pad(sheetMap.sheet, 28)} → AMBIGUOUS, ${candidates.length} candidates  expected=${expectedDesc}:`,
        );
        for (const c of candidates) {
          console.log(`         - ${c.eventId}  "${c.eventName}"  [${c.eventType}/${c.gender}]`);
        }
        ambiguous.push(sheetMap.sheet);
      }
    }
    console.log();

    if (unmatched.length || ambiguous.length) {
      console.log('NEEDS RESOLUTION:');
      for (const s of unmatched) console.log(`  - ${s}: no event matched expected type/gender`);
      for (const s of ambiguous) console.log(`  - ${s}: more than one event matched`);
      console.log();
      console.log(
        'Send the full event table above and the resolution choices and the parser ' +
          'will lock these into review.json before any writes happen.',
      );
    } else {
      console.log('All six sheets mapped cleanly. Ready to proceed to the parser step.');
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exitCode = 1;
});
