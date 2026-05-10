/**
 * Parks Cup 2026 — apply review JSON to the live tournament.
 *
 * Reads parks-cup-2026.review.json, validates against the live tournament,
 * backs the tournament up, and (in --apply mode) writes the participants,
 * pairs, event entries and seed assignments through tods-competition-factory.
 *
 * Always do a --dry-run first.
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-apply.js --dry-run \
 *     --review /tmp/parks-cup-2026.review.json
 *   docker compose exec app node build/src/scripts/parks-cup-apply.js --apply \
 *     --review /tmp/parks-cup-2026.review.json
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
const DEFAULT_REVIEW = '/tmp/parks-cup-2026.review.json';

type SheetMapping = {
  eventId: string;
  eventName: string;
  eventType: 'SINGLES' | 'DOUBLES';
  gender: 'MALE' | 'FEMALE' | 'MIXED' | 'ANY';
  enforceGender: boolean;
};

type ReviewParticipant = {
  ref: string;
  firstName: string;
  lastName: string;
  club: string;
  email?: string | null;
  phone?: string | null;
  emergencyPhone?: string | null;
  dob?: string | null;
  sex?: 'MALE' | 'FEMALE' | null;
  fromEventSheetFallback?: boolean;
  paid?: boolean;
};

type ReviewPair = {
  ref: string;
  individuals: [string, string];
  displayName: string;
  rawText?: string;
  confidence?: string;
};

type Review = {
  tournamentId: string;
  tournamentName: string;
  sheetToEvent: Record<string, SheetMapping>;
  rules: {
    entryStatus: string;
    enforceGenderPerEvent: Record<string, boolean>;
    participantStatus: string;
  };
  participants: ReviewParticipant[];
  pairs: ReviewPair[];
  enrolments: Array<{
    sheetName: string;
    eventId: string;
    eventName: string;
    eventType: 'SINGLES' | 'DOUBLES';
    individualRefs: string[];
    pairRefs: string[];
  }>;
  seedAssignments: Array<{
    sheetName: string;
    eventId: string;
    eventName: string;
    seeds: Array<{
      seedNumber: number;
      seedValue?: number | string;
      ref?: string;
      pairRef?: string;
      confidence: string;
      rawText?: string;
    }>;
  }>;
};

function getArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function deterministicId(prefix: 'individual' | 'pair', key: string): string {
  const h = crypto.createHash('sha256').update(`${prefix}:${NAMESPACE}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function buildIndividualParticipant(p: ReviewParticipant, participantId: string): any {
  const fullName = `${p.firstName} ${p.lastName}`.trim();
  const person: any = {
    standardFamilyName: p.lastName,
    standardGivenName: p.firstName,
  };
  if (p.dob) person.birthDate = p.dob;
  if (p.sex) person.sex = p.sex;
  if (p.club) {
    person.addresses = [{ addressType: 'PRIMARY', city: p.club, addressName: p.club }];
  }
  const contacts: any[] = [];
  if (p.email || p.phone) {
    const primary: any = { isPublic: false };
    if (p.email) primary.emailAddress = p.email;
    if (p.phone) primary.mobileTelephone = p.phone;
    contacts.push(primary);
  }
  if (p.emergencyPhone) {
    contacts.push({ name: 'Emergency', mobileTelephone: p.emergencyPhone, isPublic: false });
  }
  if (contacts.length) person.contacts = contacts;

  const participant: any = {
    participantId,
    participantType: 'INDIVIDUAL',
    participantRole: 'COMPETITOR',
    participantStatus: 'ACTIVE',
    participantName: fullName,
    person,
  };
  if (p.club) {
    participant.extensions = [{ name: 'club', value: { name: p.club } }];
  }
  return participant;
}

function buildPairParticipant(
  pair: ReviewPair,
  pairId: string,
  individualIds: [string, string],
): any {
  return {
    participantId: pairId,
    participantType: 'PAIR',
    participantRole: 'COMPETITOR',
    participantStatus: 'ACTIVE',
    participantName: pair.displayName,
    individualParticipantIds: [...individualIds].sort(),
  };
}

async function run() {
  const reviewPath = getArg('review', DEFAULT_REVIEW)!;
  const dryRun = hasFlag('dry-run');
  const apply = hasFlag('apply');

  if (!dryRun && !apply) {
    console.error('Provide either --dry-run or --apply (and --review <path> if not at default).');
    process.exitCode = 1;
    return;
  }
  if (dryRun && apply) {
    console.error('Pick one of --dry-run or --apply, not both.');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(reviewPath)) {
    console.error(`Review JSON not found at ${reviewPath}`);
    process.exitCode = 1;
    return;
  }

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8')) as Review;

  console.log(`Mode             : ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Tournament       : ${review.tournamentName} (${review.tournamentId})`);
  console.log(`Review JSON      : ${reviewPath}`);
  console.log();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const storage = app.get(TournamentStorageService);

    await withTournamentLock([review.tournamentId], async () => {
      const result = (await storage.findTournamentRecord({
        tournamentId: review.tournamentId,
      })) as { tournamentRecord?: any; error?: any };
      if (result.error || !result.tournamentRecord) {
        throw new Error(`Tournament not found: ${review.tournamentId}`);
      }
      const tournamentRecord = result.tournamentRecord;

      // Backup BEFORE any planning side-effect.
      const backupDir = path.join('/app', 'backups', 'parks-cup');
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        backupDir,
        `tournament-${review.tournamentId}-pre-${dryRun ? 'dryrun' : 'apply'}-${ts}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(tournamentRecord, null, 2));
      console.log(`Backup           : ${backupPath}`);
      console.log();

      // ── 1. Validate event mappings against live tournament ──────────────
      console.log('Validating event mappings…');
      for (const [sheetName, expect] of Object.entries(review.sheetToEvent)) {
        const ev = (tournamentRecord.events || []).find((e: any) => e.eventId === expect.eventId);
        if (!ev) throw new Error(`Event ${expect.eventId} (${expect.eventName}) not on tournament`);
        if (ev.eventType !== expect.eventType) {
          throw new Error(
            `[${sheetName}] event ${expect.eventId} type mismatch: expected ${expect.eventType}, got ${ev.eventType}`,
          );
        }
        if (expect.gender && ev.gender !== expect.gender && expect.gender !== 'ANY') {
          throw new Error(
            `[${sheetName}] event ${expect.eventId} gender mismatch: expected ${expect.gender}, got ${ev.gender}`,
          );
        }
      }
      console.log('  ✓ all event ids/types/genders match.');

      // ── 2. Build deterministic ID map ──────────────────────────────────
      const idMap: Record<string, string> = {};
      const individualsByRef: Record<string, ReviewParticipant> = {};
      for (const p of review.participants) {
        idMap[p.ref] = deterministicId('individual', p.ref);
        individualsByRef[p.ref] = p;
      }
      for (const pair of review.pairs) {
        const sortedRefs = [...pair.individuals].sort().join(':');
        idMap[pair.ref] = deterministicId('pair', sortedRefs);
      }

      // ── 3. Sex inference for Mixed Doubles pairs ───────────────────────
      const mixedEntry = Object.entries(review.sheetToEvent).find(
        ([, e]) => e.gender === 'MIXED' && e.enforceGender,
      );
      if (mixedEntry) {
        const [mixedSheetName] = mixedEntry;
        const mixedEnrolment = review.enrolments.find((e) => e.sheetName === mixedSheetName);
        if (mixedEnrolment) {
          let inferred = 0;
          for (const pairRef of mixedEnrolment.pairRefs) {
            const pair = review.pairs.find((p) => p.ref === pairRef);
            if (!pair) continue;
            const a = individualsByRef[pair.individuals[0]];
            const b = individualsByRef[pair.individuals[1]];
            if (a?.sex && !b?.sex) {
              b.sex = a.sex === 'MALE' ? 'FEMALE' : 'MALE';
              inferred += 1;
            } else if (b?.sex && !a?.sex) {
              a.sex = b.sex === 'MALE' ? 'FEMALE' : 'MALE';
              inferred += 1;
            } else if (!a?.sex && !b?.sex) {
              throw new Error(
                `Mixed pair has neither member with known sex: ${pair.displayName} (${pair.rawText})`,
              );
            } else if (a?.sex === b?.sex) {
              throw new Error(
                `Mixed pair has same-sex members: ${pair.displayName} both ${a.sex}`,
              );
            }
          }
          if (inferred) console.log(`Sex inferred for ${inferred} mixed-pair members.`);
        }
      }

      // Sanity: every participant going into a gender-enforced doubles event must have a sex
      for (const enrolment of review.enrolments) {
        if (!review.rules.enforceGenderPerEvent[enrolment.sheetName]) continue;
        if (enrolment.eventType !== 'DOUBLES') continue;
        for (const pairRef of enrolment.pairRefs) {
          const pair = review.pairs.find((p) => p.ref === pairRef);
          if (!pair) continue;
          for (const indRef of pair.individuals) {
            const ind = individualsByRef[indRef];
            if (!ind?.sex) {
              throw new Error(
                `Pair ${pair.displayName} on enforced-gender event ${enrolment.eventName} has member ${ind?.firstName} ${ind?.lastName} with unknown sex.`,
              );
            }
          }
        }
      }

      // ── 4. Diff against existing tournament state (for idempotency) ────
      const existingPids = new Set(
        (tournamentRecord.participants || []).map((p: any) => p.participantId),
      );
      const newIndividuals = review.participants
        .filter((p) => !existingPids.has(idMap[p.ref]))
        .map((p) => buildIndividualParticipant(p, idMap[p.ref]));

      const newPairs = review.pairs
        .filter((pair) => !existingPids.has(idMap[pair.ref]))
        .map((pair) => {
          const indAId = idMap[pair.individuals[0]];
          const indBId = idMap[pair.individuals[1]];
          return buildPairParticipant(pair, idMap[pair.ref], [indAId, indBId]);
        });

      // ── 5. Plan summary ────────────────────────────────────────────────
      console.log();
      console.log('PLAN:');
      console.log(`  participants: ${newIndividuals.length} new (${review.participants.length - newIndividuals.length} already present)`);
      console.log(`  pairs       : ${newPairs.length} new (${review.pairs.length - newPairs.length} already present)`);
      const enrolPlan: Array<{
        eventId: string;
        eventName: string;
        eventType: string;
        toAdd: string[];
        alreadyEnrolled: number;
      }> = [];
      for (const enrolment of review.enrolments) {
        const ev = tournamentRecord.events.find((e: any) => e.eventId === enrolment.eventId);
        const existingEntryIds = new Set(((ev?.entries) || []).map((e: any) => e.participantId));
        const isDoubles = enrolment.eventType === 'DOUBLES';
        const rawIds = (isDoubles ? enrolment.pairRefs : enrolment.individualRefs).map(
          (r) => idMap[r],
        );
        const desiredIds = [...new Set(rawIds)]; // dedupe (workbook has occasional dup pairings)
        const toAdd = desiredIds.filter((id) => !existingEntryIds.has(id));
        enrolPlan.push({
          eventId: enrolment.eventId,
          eventName: enrolment.eventName,
          eventType: enrolment.eventType,
          toAdd,
          alreadyEnrolled: desiredIds.length - toAdd.length,
        });
        console.log(
          `  enrol [${enrolment.eventName.padEnd(20)}] ${toAdd.length} new (${enrolPlan[enrolPlan.length - 1].alreadyEnrolled} already)`,
        );
      }
      let totalSeeds = 0;
      for (const seedSet of review.seedAssignments) {
        console.log(`  seeds [${seedSet.eventName.padEnd(20)}] ${seedSet.seeds.length} assignments`);
        totalSeeds += seedSet.seeds.length;
      }
      console.log();

      if (dryRun) {
        console.log('DRY-RUN: plan validated, no writes performed.');
        // Print first few participant payloads as a sample
        if (newIndividuals.length) {
          console.log();
          console.log('Sample individual payload (first):');
          console.log(JSON.stringify(newIndividuals[0], null, 2));
        }
        if (newPairs.length) {
          console.log();
          console.log('Sample pair payload (first):');
          console.log(JSON.stringify(newPairs[0], null, 2));
        }
        return;
      }

      // ── 6. APPLY ───────────────────────────────────────────────────────
      console.log('APPLYING…');

      if (newIndividuals.length || newPairs.length) {
        // Add individuals first so pair.individualParticipantIds resolve.
        if (newIndividuals.length) {
          const r: any = (participantGovernor as any).addParticipants({
            tournamentRecord,
            participants: newIndividuals,
            allowDuplicateParticipantIdPairs: false,
          });
          if (r?.error) throw new Error(`addParticipants(individuals) failed: ${JSON.stringify(r.error)}`);
          console.log(`  added ${newIndividuals.length} individual participants.`);
        }
        if (newPairs.length) {
          const r: any = (participantGovernor as any).addParticipants({
            tournamentRecord,
            participants: newPairs,
            allowDuplicateParticipantIdPairs: false,
          });
          if (r?.error) throw new Error(`addParticipants(pairs) failed: ${JSON.stringify(r.error)}`);
          console.log(`  added ${newPairs.length} pair participants.`);
        }
      }

      for (const plan of enrolPlan) {
        if (!plan.toAdd.length) continue;
        const ev = tournamentRecord.events.find((e: any) => e.eventId === plan.eventId);
        const sheet = Object.entries(review.sheetToEvent).find(
          ([, mapping]) => mapping.eventId === plan.eventId,
        )![0];
        const r: any = (entriesGovernor as any).addEventEntries({
          tournamentRecord,
          event: ev,
          participantIds: plan.toAdd,
          entryStatus: review.rules.entryStatus,
          enforceGender: review.rules.enforceGenderPerEvent[sheet],
        });
        if (r?.error) {
          throw new Error(
            `addEventEntries failed for ${plan.eventName}: ${JSON.stringify(r.error)}`,
          );
        }
        console.log(`  enrolled ${plan.toAdd.length} into ${plan.eventName}.`);
      }

      // Set seed assignments at event level (replaces, idempotent)
      for (const seedSet of review.seedAssignments) {
        const ev = tournamentRecord.events.find((e: any) => e.eventId === seedSet.eventId);
        if (!ev) continue;
        const seedAssignments = seedSet.seeds.map((s) => {
          const pid = s.ref ? idMap[s.ref] : s.pairRef ? idMap[s.pairRef] : null;
          if (!pid) {
            throw new Error(
              `Cannot resolve seed participantId for seed ${s.seedNumber} on ${seedSet.eventName}`,
            );
          }
          return {
            seedNumber: s.seedNumber,
            seedValue: s.seedValue ?? s.seedNumber,
            participantId: pid,
          };
        });
        ev.seedAssignments = seedAssignments;
        console.log(`  set ${seedAssignments.length} seed assignments on ${seedSet.eventName}.`);
      }

      // ── 7. Reconcile counts post-mutation ──────────────────────────────
      const finalParticipantCount = (tournamentRecord.participants || []).length;
      const expectedParticipantCount = existingPids.size + newIndividuals.length + newPairs.length;
      if (finalParticipantCount !== expectedParticipantCount) {
        throw new Error(
          `Participant count mismatch after add: expected ${expectedParticipantCount}, got ${finalParticipantCount}. ABORT save.`,
        );
      }
      for (const plan of enrolPlan) {
        const ev = tournamentRecord.events.find((e: any) => e.eventId === plan.eventId);
        const entryCount = (ev?.entries || []).length;
        const expectedMin = plan.alreadyEnrolled + plan.toAdd.length;
        if (entryCount < expectedMin) {
          throw new Error(
            `Entry count low on ${plan.eventName}: expected ≥ ${expectedMin}, got ${entryCount}. ABORT save.`,
          );
        }
      }

      // ── 8. Save ────────────────────────────────────────────────────────
      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);

      console.log();
      console.log('APPLIED.');
      console.log(`  participants total: ${finalParticipantCount}`);
      console.log(`  seeds set         : ${totalSeeds}`);
      console.log(`  backup at         : ${backupPath}`);
      console.log();
      console.log('Verify on the public draws view, then in TMX. To roll back:');
      console.log(`  docker compose exec app node build/src/scripts/parks-cup-restore.js --backup ${backupPath}`);
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
