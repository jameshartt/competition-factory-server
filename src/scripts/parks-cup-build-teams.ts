/**
 * Build Team participants for the Parks Cup 2026 tournament from each
 * individual's club (read from person.addresses[0].city, falling back to the
 * 'club' extension). One TEAM participant per unique canonical club.
 *
 * Purely additive: only adds new Team participants and (on re-run) merges any
 * new individuals into existing Teams. Does NOT modify existing INDIVIDUAL or
 * PAIR participants, event.entries, seedAssignments, drawDefinitions or
 * matchUps. Safe to run alongside an existing post-draw tournament.
 *
 * Run dry-run first to inspect the plan.
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-build-teams.js --dry-run
 *   docker compose exec app node build/src/scripts/parks-cup-build-teams.js --apply
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

/**
 * Manual club assignments for individuals whose Master List or event-sheet row
 * lacked a club — confirmed by Jim and persisted on the participant's
 * addresses[0].city + extensions['club'] so they're indistinguishable from
 * imported club data going forward.
 *
 * Keyed by the parser ref (matches the deterministic-id namespace used at
 * apply time); resolved to participantId via deterministicId('individual', ref).
 */
const MANUAL_CLUB: Record<string, string> = {
  p_seb_moore_evans: "St Ann's", // confirmed by Jim 2026-05-06
  p_troy_raftery: 'Preston Park', // confirmed by Jim 2026-05-06
};

// Same map used by parse.mjs — collapses spelling variants to one canonical
// club so each club becomes exactly one Team participant.
const CLUB_CANONICAL: Record<string, string> = {
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

function canonicalClub(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.toString().trim();
  if (!t) return null;
  return CLUB_CANONICAL[t.toLowerCase()] || t;
}

function deterministicId(prefix: 'team' | 'individual', key: string): string {
  const h = crypto.createHash('sha256').update(`${prefix}:${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function clubFromIndividual(p: any): string | null {
  const fromAddress = p.person?.addresses?.[0]?.city;
  if (fromAddress) return canonicalClub(fromAddress);
  const ext = (p.extensions || []).find((e: any) => e.name === 'club');
  if (ext?.value?.name) return canonicalClub(ext.value.name);
  return null;
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

      // Pre-mutation snapshot — counts that we MUST preserve exactly.
      const preCounts = {
        individuals: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'INDIVIDUAL',
        ).length,
        pairs: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'PAIR',
        ).length,
        teams: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'TEAM',
        ).length,
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
        `tournament-${TOURNAMENT_ID}-pre-build-teams-${ts}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(tournamentRecord, null, 2));
      console.log(`Backup: ${backupPath}`);
      console.log();

      // ── Apply MANUAL_CLUB overrides to individuals (in-memory). These touch
      // person.addresses + extensions only; never touches entries/draws/seeds.
      const manualClubApplied: Array<{ ref: string; participantId: string; club: string; participantName: string }> = [];
      for (const [ref, club] of Object.entries(MANUAL_CLUB)) {
        const pid = deterministicId('individual', ref);
        const participant = (tournamentRecord.participants || []).find(
          (p: any) => p.participantId === pid,
        );
        if (!participant) {
          console.warn(`MANUAL_CLUB: participant ref=${ref} (${pid}) not found — skipping`);
          continue;
        }
        // Set / update addresses[0]
        const addresses = participant.person?.addresses || [];
        if (addresses.length === 0) {
          participant.person = participant.person || {};
          participant.person.addresses = [
            { addressType: 'PRIMARY', city: club, addressName: club },
          ];
        } else {
          addresses[0].city = club;
          if (!addresses[0].addressName) addresses[0].addressName = club;
        }
        // Set / update extensions[club]
        participant.extensions = participant.extensions || [];
        const ext = participant.extensions.find((e: any) => e.name === 'club');
        if (ext) {
          ext.value = { ...(ext.value || {}), name: club };
        } else {
          participant.extensions.push({ name: 'club', value: { name: club } });
        }
        manualClubApplied.push({
          ref,
          participantId: pid,
          club,
          participantName: participant.participantName || `${participant.person?.standardGivenName} ${participant.person?.standardFamilyName}`,
        });
      }
      if (manualClubApplied.length) {
        console.log('Manual club assignments applied:');
        for (const a of manualClubApplied) console.log(`  ${a.participantName} → ${a.club}`);
        console.log();
      }

      // ── Group individuals by canonical club ────────────────────────────
      const allParticipants: any[] = tournamentRecord.participants || [];
      const individualsByClub = new Map<string, string[]>(); // clubName → [participantId, ...]
      const noClubIndividuals: any[] = [];

      for (const p of allParticipants) {
        if (p.participantType !== 'INDIVIDUAL') continue;
        const club = clubFromIndividual(p);
        if (!club) {
          noClubIndividuals.push(p);
          continue;
        }
        if (!individualsByClub.has(club)) individualsByClub.set(club, []);
        individualsByClub.get(club)!.push(p.participantId);
      }

      // Sort club names for deterministic output
      const clubsSorted = [...individualsByClub.keys()].sort();

      // ── Plan summary ───────────────────────────────────────────────────
      console.log('Existing tournament shape:');
      console.log(`  individuals : ${preCounts.individuals}`);
      console.log(`  pairs       : ${preCounts.pairs}`);
      console.log(`  teams       : ${preCounts.teams}`);
      console.log();
      console.log('PLAN — Teams to create or update:');

      const planRows: Array<{
        club: string;
        teamId: string;
        action: 'create' | 'update' | 'noop';
        before: number;
        after: number;
        added: string[]; // participantIds being added to membership
      }> = [];

      for (const club of clubsSorted) {
        const teamId = deterministicId('team', club);
        const desiredMemberIds = new Set(individualsByClub.get(club)!);
        const existingTeam = allParticipants.find((p: any) => p.participantId === teamId);

        if (!existingTeam) {
          planRows.push({
            club,
            teamId,
            action: 'create',
            before: 0,
            after: desiredMemberIds.size,
            added: [...desiredMemberIds],
          });
        } else {
          const currentMembers = new Set<string>(existingTeam.individualParticipantIds || []);
          const toAdd = [...desiredMemberIds].filter((id) => !currentMembers.has(id));
          planRows.push({
            club,
            teamId,
            action: toAdd.length ? 'update' : 'noop',
            before: currentMembers.size,
            after: currentMembers.size + toAdd.length,
            added: toAdd,
          });
        }
      }

      const colW = Math.max(...clubsSorted.map((c) => c.length), 12);
      for (const row of planRows) {
        const tag =
          row.action === 'create' ? 'CREATE' : row.action === 'update' ? 'UPDATE' : 'noop  ';
        console.log(
          `  [${tag}] ${row.club.padEnd(colW)}  members ${row.before} → ${row.after}   teamId=${row.teamId}`,
        );
      }

      if (noClubIndividuals.length) {
        console.log();
        console.log(`${noClubIndividuals.length} individuals have no club — left out of all Teams:`);
        for (const p of noClubIndividuals) {
          console.log(`    ${p.participantName || `${p.person?.standardGivenName} ${p.person?.standardFamilyName}`}`);
        }
      }

      const totalTeamsCreating = planRows.filter((r) => r.action === 'create').length;
      const totalTeamsUpdating = planRows.filter((r) => r.action === 'update').length;
      const totalMembershipAdds = planRows.reduce((s, r) => s + r.added.length, 0);

      console.log();
      console.log(`Summary: create=${totalTeamsCreating}, update=${totalTeamsUpdating}, noop=${planRows.length - totalTeamsCreating - totalTeamsUpdating}, total members added=${totalMembershipAdds}`);
      console.log();

      // ── Cross-coverage sanity ──────────────────────────────────────────
      const coveredCount = clubsSorted.reduce(
        (s, c) => s + individualsByClub.get(c)!.length,
        0,
      );
      console.log(`Coverage: ${coveredCount}/${preCounts.individuals} individuals → a Team`);
      console.log();

      if (dryRun) {
        console.log('DRY-RUN: no writes performed.');
        return;
      }

      // ── Apply ──────────────────────────────────────────────────────────
      const teamsToCreate: any[] = [];
      for (const row of planRows) {
        if (row.action === 'create') {
          teamsToCreate.push({
            participantId: row.teamId,
            participantType: 'TEAM',
            participantRole: 'COMPETITOR',
            participantStatus: 'ACTIVE',
            participantName: row.club,
            individualParticipantIds: [...row.added].sort(),
          });
        } else if (row.action === 'update') {
          const team = allParticipants.find((p: any) => p.participantId === row.teamId);
          const merged = new Set<string>(team.individualParticipantIds || []);
          for (const id of row.added) merged.add(id);
          team.individualParticipantIds = [...merged].sort();
        }
      }

      if (teamsToCreate.length) {
        const r: any = (participantGovernor as any).addParticipants({
          tournamentRecord,
          participants: teamsToCreate,
          allowDuplicateParticipantIdPairs: false,
        });
        if (r?.error) throw new Error(`addParticipants(teams) failed: ${JSON.stringify(r.error)}`);
        console.log(`  added ${teamsToCreate.length} Team participants.`);
      }
      if (totalTeamsUpdating) {
        console.log(`  merged membership into ${totalTeamsUpdating} existing Teams.`);
      }

      // ── Post-mutation invariant assertions ─────────────────────────────
      const post = {
        individuals: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'INDIVIDUAL',
        ).length,
        pairs: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'PAIR',
        ).length,
        teams: (tournamentRecord.participants || []).filter(
          (p: any) => p.participantType === 'TEAM',
        ).length,
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
        ['individuals unchanged', preCounts.individuals, post.individuals],
        ['pairs unchanged', preCounts.pairs, post.pairs],
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
      console.log(`  ✓ all ${checks.length} invariants hold (no draws/entries/seeds touched).`);

      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);

      console.log();
      console.log('APPLIED.');
      console.log(`  teams now total: ${post.teams}`);
      console.log(`  backup at      : ${backupPath}`);
      console.log();
      console.log('To roll back:');
      console.log(`  docker compose exec app node build/src/scripts/parks-cup-restore.js --backup ${backupPath} --force`);
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
