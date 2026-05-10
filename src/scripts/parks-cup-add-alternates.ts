/**
 * Add late-registered alternate individuals to the Parks Cup 2026 tournament.
 * Purely additive — does NOT touch event entries, pairs, draws, or seeds.
 * Jim adds them to events manually via TMX after this runs.
 *
 * For individuals with a known club, also adds them to that club's Team
 * (additive merge into Team.individualParticipantIds).
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-add-alternates.js --dry-run
 *   docker compose exec app node build/src/scripts/parks-cup-add-alternates.js --apply
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { participantGovernor } from 'tods-competition-factory';

import { AppModule } from '../modules/app/app.module';
import { TournamentStorageService } from '../storage/tournament-storage.service';
import { withTournamentLock } from '../services/tournamentMutex';

const NAMESPACE = 'parks-cup-2026';
const TOURNAMENT_ID = '72410e93-4749-4ab9-9e11-91e809ea5b9a';

type Alternate = {
  ref: string;
  firstName: string;
  lastName: string;
  sex: 'MALE' | 'FEMALE';
  club: string | null;
  reason: string;
};

const ALTERNATES: Alternate[] = [
  {
    ref: 'p_patricia_pollard',
    firstName: 'Patricia',
    lastName: 'Pollard',
    sex: 'FEMALE',
    club: 'Hove',
    reason: 'Confirmed by Jim 2026-05-06: late alternate registration, Hove.',
  },
  {
    ref: 'p_frederick_holmes',
    firstName: 'Frederick',
    lastName: 'Holmes',
    sex: 'MALE',
    club: null,
    reason: 'Confirmed by Jim 2026-05-06: late alternate registration, club unknown.',
  },
];

const CLUB_CANONICAL: Record<string, string> = {
  "st ann's": "St Ann's",
  'st anns': "St Ann's",
  hove: 'Hove',
  dyke: 'Dyke',
  queens: 'Queens',
  'king alfred': 'King Alfred',
  saltdean: 'Saltdean',
  'preston park': 'Preston Park',
  'park avenue': 'Park Avenue',
  blakers: 'Blakers',
};

function canonicalClub(raw: string | null): string | null {
  if (!raw) return null;
  return CLUB_CANONICAL[raw.toLowerCase()] || raw;
}

function deterministicId(prefix: 'individual' | 'team', key: string): string {
  const h = crypto.createHash('sha256').update(`${prefix}:${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function buildIndividualParticipant(a: Alternate, participantId: string) {
  const fullName = `${a.firstName} ${a.lastName}`;
  const person: any = {
    standardFamilyName: a.lastName,
    standardGivenName: a.firstName,
    sex: a.sex,
  };
  const club = canonicalClub(a.club);
  if (club) {
    person.addresses = [{ addressType: 'PRIMARY', city: club, addressName: club }];
  }
  const participant: any = {
    participantId,
    participantType: 'INDIVIDUAL',
    participantRole: 'COMPETITOR',
    participantStatus: 'ACTIVE',
    participantName: fullName,
    person,
  };
  if (club) {
    participant.extensions = [{ name: 'club', value: { name: club } }];
  }
  return participant;
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

      // Pre-mutation invariants we MUST preserve.
      const preCounts = {
        individuals: tournamentRecord.participants.filter(
          (p: any) => p.participantType === 'INDIVIDUAL',
        ).length,
        pairs: tournamentRecord.participants.filter((p: any) => p.participantType === 'PAIR').length,
        teams: tournamentRecord.participants.filter((p: any) => p.participantType === 'TEAM').length,
        events: (tournamentRecord.events || []).length,
        entriesByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.entries || []).length,
          ]),
        ),
        seedAssignmentsByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.seedAssignments || []).length,
          ]),
        ),
        drawDefinitionsByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.drawDefinitions || []).length,
          ]),
        ),
      };

      // Backup
      const backupDir = path.join('/app', 'backups', 'parks-cup');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        backupDir,
        `tournament-${TOURNAMENT_ID}-pre-add-alternates-${ts}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(tournamentRecord, null, 2));
      console.log(`Backup: ${backupPath}`);
      console.log();

      // ── Plan + apply per alternate ────────────────────────────────────
      console.log('PLAN:');
      const newIndividuals: any[] = [];
      const teamMembershipUpdates: Array<{
        teamId: string;
        teamName: string;
        addRefId: string;
        addName: string;
      }> = [];

      for (const alt of ALTERNATES) {
        const pid = deterministicId('individual', alt.ref);
        const exists = tournamentRecord.participants.some(
          (p: any) => p.participantId === pid,
        );
        const club = canonicalClub(alt.club);

        let teamPlanLine = '';
        if (club) {
          const teamId = deterministicId('team', club);
          const team = tournamentRecord.participants.find(
            (p: any) => p.participantId === teamId && p.participantType === 'TEAM',
          );
          if (team) {
            const already = (team.individualParticipantIds || []).includes(pid);
            teamPlanLine = `  → Team ${club} ${already ? '(already member)' : '(will add)'}`;
            if (!already) {
              teamMembershipUpdates.push({
                teamId,
                teamName: club,
                addRefId: pid,
                addName: `${alt.firstName} ${alt.lastName}`,
              });
            }
          } else {
            teamPlanLine = `  → Team ${club} NOT FOUND on tournament — skipping team add`;
          }
        } else {
          teamPlanLine = '  → no club, no Team membership';
        }

        const action = exists ? 'noop  ' : 'CREATE';
        console.log(
          `  [${action}] ${alt.firstName} ${alt.lastName}  sex=${alt.sex}  club=${club || '(none)'}  pid=${pid}`,
        );
        console.log(`    ${alt.reason}`);
        console.log(`    ${teamPlanLine}`);

        if (!exists) {
          newIndividuals.push(buildIndividualParticipant(alt, pid));
        }
      }
      console.log();
      console.log(
        `Summary: create=${newIndividuals.length}  team-membership-adds=${teamMembershipUpdates.length}`,
      );
      console.log();

      if (dryRun) {
        console.log('DRY-RUN: no writes performed.');
        return;
      }

      // ── Apply ──────────────────────────────────────────────────────────
      if (newIndividuals.length) {
        const r: any = (participantGovernor as any).addParticipants({
          tournamentRecord,
          participants: newIndividuals,
          allowDuplicateParticipantIdPairs: false,
        });
        if (r?.error) throw new Error(`addParticipants failed: ${JSON.stringify(r.error)}`);
        console.log(`  added ${newIndividuals.length} INDIVIDUAL participants.`);
      }
      for (const tu of teamMembershipUpdates) {
        const team = tournamentRecord.participants.find(
          (p: any) => p.participantId === tu.teamId,
        );
        if (!team) continue;
        const members = new Set<string>(team.individualParticipantIds || []);
        members.add(tu.addRefId);
        team.individualParticipantIds = [...members].sort();
        console.log(`  added ${tu.addName} → Team ${tu.teamName}`);
      }

      // ── Post-mutation invariant assertions ─────────────────────────────
      const post = {
        individuals: tournamentRecord.participants.filter(
          (p: any) => p.participantType === 'INDIVIDUAL',
        ).length,
        pairs: tournamentRecord.participants.filter((p: any) => p.participantType === 'PAIR').length,
        teams: tournamentRecord.participants.filter((p: any) => p.participantType === 'TEAM').length,
        events: (tournamentRecord.events || []).length,
        entriesByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.entries || []).length,
          ]),
        ),
        seedAssignmentsByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.seedAssignments || []).length,
          ]),
        ),
        drawDefinitionsByEvent: Object.fromEntries(
          (tournamentRecord.events || []).map((e: any) => [
            e.eventId,
            (e.drawDefinitions || []).length,
          ]),
        ),
      };

      const checks: Array<[string, any, any]> = [
        ['individuals delta', preCounts.individuals + newIndividuals.length, post.individuals],
        ['pairs unchanged', preCounts.pairs, post.pairs],
        ['teams unchanged', preCounts.teams, post.teams],
        ['events unchanged', preCounts.events, post.events],
      ];
      for (const eventId of Object.keys(preCounts.entriesByEvent)) {
        checks.push([
          `entries[${eventId}] unchanged`,
          preCounts.entriesByEvent[eventId],
          post.entriesByEvent[eventId],
        ]);
        checks.push([
          `seedAssignments[${eventId}] unchanged`,
          preCounts.seedAssignmentsByEvent[eventId],
          post.seedAssignmentsByEvent[eventId],
        ]);
        checks.push([
          `drawDefinitions[${eventId}] unchanged`,
          preCounts.drawDefinitionsByEvent[eventId],
          post.drawDefinitionsByEvent[eventId],
        ]);
      }
      const violations = checks.filter(([, a, b]) => a !== b);
      if (violations.length) {
        console.error('INVARIANT VIOLATIONS — refusing to save:');
        for (const [name, before, after] of violations) {
          console.error(`  ${name}: was ${before}, now ${after}`);
        }
        throw new Error(`Aborting save: ${violations.length} invariant violations.`);
      }
      console.log(`  ✓ all ${checks.length} invariants hold (no entries/seeds/draws touched).`);

      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);

      console.log();
      console.log('APPLIED.');
      console.log(`  individuals total: ${post.individuals}`);
      console.log(`  backup at        : ${backupPath}`);
      console.log();
      console.log('To roll back:');
      console.log(`  docker compose exec app node build/src/scripts/parks-cup-restore.js --backup ${backupPath} --force`);
      console.log();
      console.log('Now add them to events manually via TMX.');
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
