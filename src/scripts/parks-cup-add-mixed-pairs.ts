/**
 * Add a list of Mixed Doubles pairs to the live tournament.
 *
 * Hardcoded list of pairs to add — edit PAIRS, redeploy, run.
 * Idempotent: skips pairs that already exist (by deterministic id).
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-add-mixed-pairs.js --dry-run
 *   docker compose exec app node build/src/scripts/parks-cup-add-mixed-pairs.js --apply
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { participantGovernor, entriesGovernor } from 'tods-competition-factory';

import { AppModule } from '../modules/app/app.module';
import { TournamentStorageService } from '../storage/tournament-storage.service';
import { withTournamentLock } from '../services/tournamentMutex';

const NAMESPACE = 'parks-cup-2026';
const TOURNAMENT_ID = '72410e93-4749-4ab9-9e11-91e809ea5b9a';
const MIXED_EVENT_ID = '266b7836-5bf1-49d2-ba92-d72e9e610a0f';

/**
 * Each entry: refs of the two individuals, in any order.
 * The pair's deterministic id is computed from sorted refs, matching the
 * convention in parks-cup-apply.ts.
 */
const PAIRS: Array<{ refA: string; refB: string; reason: string }> = [
  {
    refA: 'p_sean_mahon',
    refB: 'p_kate_mahon',
    reason: 'Confirmed by Jim 2026-05-06: married couple, Queens.',
  },
  {
    refA: 'p_kisoran_moodley',
    refB: 'p_sarah_brooking',
    reason: 'Confirmed by Jim 2026-05-06: King Alfred Mixed pair.',
  },
];

function deterministicId(prefix: 'individual' | 'pair', key: string): string {
  const h = crypto.createHash('sha256').update(`${prefix}:${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (!dryRun && !apply) {
    console.error('Provide --dry-run or --apply');
    process.exitCode = 1;
    return;
  }

  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Tournament: ${TOURNAMENT_ID}`);
  console.log();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const storage = app.get(TournamentStorageService);

    await withTournamentLock([TOURNAMENT_ID], async () => {
      const result = (await storage.findTournamentRecord({
        tournamentId: TOURNAMENT_ID,
      })) as { tournamentRecord?: any; error?: any };
      if (result.error || !result.tournamentRecord) {
        throw new Error(`Tournament not found: ${TOURNAMENT_ID}`);
      }
      const tournamentRecord = result.tournamentRecord;

      // Backup
      const backupDir = path.join('/app', 'backups', 'parks-cup');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        backupDir,
        `tournament-${TOURNAMENT_ID}-pre-add-mixed-pairs-${ts}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(tournamentRecord, null, 2));
      console.log(`Backup: ${backupPath}`);
      console.log();

      const mixedEvent = tournamentRecord.events.find((e: any) => e.eventId === MIXED_EVENT_ID);
      if (!mixedEvent) throw new Error('Mixed Doubles event not found');

      const newPairsToAdd: any[] = [];
      const newEntries: string[] = [];

      for (const { refA, refB, reason } of PAIRS) {
        const indAId = deterministicId('individual', refA);
        const indBId = deterministicId('individual', refB);
        const a = tournamentRecord.participants.find((p: any) => p.participantId === indAId);
        const b = tournamentRecord.participants.find((p: any) => p.participantId === indBId);
        if (!a) throw new Error(`Individual ${refA} (${indAId}) not on tournament`);
        if (!b) throw new Error(`Individual ${refB} (${indBId}) not on tournament`);
        if (!a.person?.sex || !b.person?.sex) {
          throw new Error(`Pair ${refA}+${refB} has unknown sex on at least one half`);
        }
        if (a.person.sex === b.person.sex) {
          throw new Error(`Pair ${refA}+${refB} same-sex (both ${a.person.sex}); not valid for Mixed`);
        }

        const sortedRefs = [refA, refB].sort().join(':');
        const pairId = deterministicId('pair', sortedRefs);
        const existingPair = tournamentRecord.participants.find(
          (p: any) => p.participantId === pairId,
        );
        const alreadyOnEvent = (mixedEvent.entries || []).some(
          (e: any) => e.participantId === pairId,
        );

        const pairName = `${a.person.standardGivenName} ${a.person.standardFamilyName} / ${b.person.standardGivenName} ${b.person.standardFamilyName}`;
        console.log(
          `  ${pairName}  pairId=${pairId}  exists=${!!existingPair}  enrolled=${alreadyOnEvent}`,
        );
        console.log(`    reason: ${reason}`);

        if (!existingPair) {
          newPairsToAdd.push({
            participantId: pairId,
            participantType: 'PAIR',
            participantRole: 'COMPETITOR',
            participantStatus: 'ACTIVE',
            participantName: pairName,
            individualParticipantIds: [indAId, indBId].sort(),
          });
        }
        if (!alreadyOnEvent) {
          newEntries.push(pairId);
        }
      }

      console.log();
      console.log(`PLAN: addParticipants=${newPairsToAdd.length}  addEntries=${newEntries.length}`);

      if (dryRun) {
        console.log('DRY-RUN: no writes performed.');
        return;
      }

      if (newPairsToAdd.length) {
        const r: any = (participantGovernor as any).addParticipants({
          tournamentRecord,
          participants: newPairsToAdd,
          allowDuplicateParticipantIdPairs: false,
        });
        if (r?.error) throw new Error(`addParticipants failed: ${JSON.stringify(r.error)}`);
        console.log(`  added ${newPairsToAdd.length} pair participants.`);
      }
      if (newEntries.length) {
        const r: any = (entriesGovernor as any).addEventEntries({
          tournamentRecord,
          event: mixedEvent,
          participantIds: newEntries,
          entryStatus: 'DIRECT_ACCEPTANCE',
          enforceGender: true,
        });
        if (r?.error) throw new Error(`addEventEntries failed: ${JSON.stringify(r.error)}`);
        console.log(`  enrolled ${newEntries.length} pairs into Mixed Doubles.`);
      }

      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);

      console.log();
      console.log('APPLIED.');
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
