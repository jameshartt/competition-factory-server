/**
 * One-off fix: remove the "Reeves/Davis" Mixed Doubles pair (withdrawn) and
 * create a new "Davis/Milonas" pair in its place.
 *
 *   - Delete pair participant Reeves/Davis (id 01b2e961-...) and its WITHDRAWN entry
 *   - Create new pair Joannah Davis & Stephen Milonas (deterministic id matching
 *     the parks-cup-apply script's NAMESPACE convention)
 *   - Enrol that new pair into Mixed Doubles as DIRECT_ACCEPTANCE
 *
 * Both individuals already exist on the tournament from the original import.
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-fix-davis-milonas.js --dry-run
 *   docker compose exec app node build/src/scripts/parks-cup-fix-davis-milonas.js --apply
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
const STALE_PAIR_ID = '01b2e961-86ed-4867-863e-2504cbdf1360'; // Reeves/Davis (WITHDRAWN)

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

  const joannahId = deterministicId('individual', 'p_joannah_davis');
  const stephenId = deterministicId('individual', 'p_stephen_milonas');
  const newPairKey = ['p_joannah_davis', 'p_stephen_milonas'].sort().join(':');
  const newPairId = deterministicId('pair', newPairKey);

  console.log(`Mode             : ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Joannah Davis    : ${joannahId}`);
  console.log(`Stephen Milonas  : ${stephenId}`);
  console.log(`New pair id      : ${newPairId}`);
  console.log(`Stale pair id    : ${STALE_PAIR_ID} (Reeves/Davis, WITHDRAWN)`);
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
        `tournament-${TOURNAMENT_ID}-pre-fix-davis-milonas-${ts}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(tournamentRecord, null, 2));
      console.log(`Backup           : ${backupPath}`);
      console.log();

      // ── Validate state ─────────────────────────────────────────────────
      const stalePair = tournamentRecord.participants?.find(
        (p: any) => p.participantId === STALE_PAIR_ID,
      );
      if (!stalePair) {
        console.log('Stale Reeves/Davis pair already gone. Continuing.');
      } else {
        console.log(`Found stale pair: ${stalePair.participantName}`);
      }

      const mixedEvent = tournamentRecord.events.find((e: any) => e.eventId === MIXED_EVENT_ID);
      if (!mixedEvent) throw new Error('Mixed Doubles event not found');

      const staleEntry = (mixedEvent.entries || []).find(
        (e: any) => e.participantId === STALE_PAIR_ID,
      );
      if (staleEntry) {
        console.log(
          `Found stale entry on Mixed: status=${staleEntry.entryStatus} stage=${staleEntry.entryStage} pos=${staleEntry.entryPosition}`,
        );
      } else {
        console.log('No stale entry on Mixed for that pair.');
      }

      const joannah = tournamentRecord.participants.find((p: any) => p.participantId === joannahId);
      const stephen = tournamentRecord.participants.find((p: any) => p.participantId === stephenId);
      if (!joannah) throw new Error(`Joannah Davis (${joannahId}) not on tournament`);
      if (!stephen) throw new Error(`Stephen Milonas (${stephenId}) not on tournament`);
      console.log(`✓ Joannah Davis present: ${joannah.participantName} sex=${joannah.person?.sex}`);
      console.log(`✓ Stephen Milonas present: ${stephen.participantName} sex=${stephen.person?.sex}`);

      // Sex-check the new pair will satisfy Mixed Doubles enforceGender
      if (joannah.person?.sex === stephen.person?.sex) {
        throw new Error(`Both have same sex (${joannah.person?.sex}); cannot form Mixed pair`);
      }

      const existingNewPair = tournamentRecord.participants?.find(
        (p: any) => p.participantId === newPairId,
      );
      console.log(
        existingNewPair
          ? `Davis/Milonas pair already exists (${newPairId}); will not duplicate.`
          : `Davis/Milonas pair will be created (${newPairId}).`,
      );
      console.log();

      // ── Plan summary ───────────────────────────────────────────────────
      console.log('PLAN:');
      console.log(`  remove pair participant   : ${stalePair ? 1 : 0}`);
      console.log(`  remove Mixed entry        : ${staleEntry ? 1 : 0}`);
      console.log(`  add new pair participant  : ${existingNewPair ? 0 : 1}`);
      console.log(`  add Mixed entry for pair  : ${
        (mixedEvent.entries || []).some((e: any) => e.participantId === newPairId) ? 0 : 1
      }`);
      console.log();

      if (dryRun) {
        console.log('DRY-RUN: no writes performed.');
        return;
      }

      // ── Apply ──────────────────────────────────────────────────────────
      // 1. Remove stale Mixed entry
      if (staleEntry) {
        mixedEvent.entries = mixedEvent.entries.filter(
          (e: any) => e.participantId !== STALE_PAIR_ID,
        );
        console.log('  removed stale Mixed entry.');
      }

      // 2. Remove stale pair participant
      if (stalePair) {
        tournamentRecord.participants = tournamentRecord.participants.filter(
          (p: any) => p.participantId !== STALE_PAIR_ID,
        );
        console.log('  removed stale pair participant.');
      }

      // 3. Add new Davis/Milonas pair (if not already present)
      if (!existingNewPair) {
        const newPair = {
          participantId: newPairId,
          participantType: 'PAIR',
          participantRole: 'COMPETITOR',
          participantStatus: 'ACTIVE',
          participantName: `${joannah.person.standardGivenName} ${joannah.person.standardFamilyName} / ${stephen.person.standardGivenName} ${stephen.person.standardFamilyName}`,
          individualParticipantIds: [joannahId, stephenId].sort(),
        };
        const r: any = (participantGovernor as any).addParticipants({
          tournamentRecord,
          participants: [newPair],
          allowDuplicateParticipantIdPairs: false,
        });
        if (r?.error) throw new Error(`addParticipants failed: ${JSON.stringify(r.error)}`);
        console.log('  added Davis/Milonas pair.');
      }

      // 4. Enrol new pair on Mixed Doubles
      const alreadyOnMixed = (mixedEvent.entries || []).some(
        (e: any) => e.participantId === newPairId,
      );
      if (!alreadyOnMixed) {
        const r: any = (entriesGovernor as any).addEventEntries({
          tournamentRecord,
          event: mixedEvent,
          participantIds: [newPairId],
          entryStatus: 'DIRECT_ACCEPTANCE',
          enforceGender: true,
        });
        if (r?.error) {
          throw new Error(`addEventEntries failed: ${JSON.stringify(r.error)}`);
        }
        console.log('  enrolled Davis/Milonas in Mixed Doubles.');
      }

      // ── Save ───────────────────────────────────────────────────────────
      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);

      console.log();
      console.log('FIX APPLIED.');
      console.log(`  backup at: ${backupPath}`);
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
