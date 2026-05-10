/**
 * Restore a tournament from a JSON backup written by parks-cup-apply.ts.
 *
 * Usage:
 *   docker compose exec app node build/src/scripts/parks-cup-restore.js \
 *     --backup /app/backups/parks-cup/tournament-<id>-pre-apply-<ts>.json
 */
import * as fs from 'node:fs';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../modules/app/app.module';
import { TournamentStorageService } from '../storage/tournament-storage.service';
import { withTournamentLock } from '../services/tournamentMutex';

function getArg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

async function run() {
  const backupPath = getArg('backup');
  const force = process.argv.includes('--force');

  if (!backupPath) {
    console.error('Provide --backup <path-to-backup.json>');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    process.exitCode = 1;
    return;
  }

  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!backup?.tournamentId) {
    console.error('Backup file missing tournamentId — refusing to restore.');
    process.exitCode = 1;
    return;
  }

  console.log(`Restoring tournament ${backup.tournamentId} (${backup.tournamentName || '(no name)'})`);
  console.log(`Source backup       : ${backupPath}`);
  console.log(`Events in backup    : ${(backup.events || []).length}`);
  console.log(`Participants in backup: ${(backup.participants || []).length}`);

  if (!force) {
    console.log();
    console.log('This will OVERWRITE the live tournament with the backup contents.');
    console.log('Re-run with --force to proceed.');
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const storage = app.get(TournamentStorageService);

    await withTournamentLock([backup.tournamentId], async () => {
      // Snapshot the CURRENT live state too, before clobbering — in case the user
      // wants to undo the restore.
      const currentRes = (await storage.findTournamentRecord({
        tournamentId: backup.tournamentId,
      })) as { tournamentRecord?: any; error?: any };
      if (currentRes.tournamentRecord) {
        const safetyPath = `${backupPath}.pre-restore-snapshot-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(safetyPath, JSON.stringify(currentRes.tournamentRecord, null, 2));
        console.log(`Pre-restore snapshot of live state: ${safetyPath}`);
      }

      const saveResult: any = await storage.saveTournamentRecord({ tournamentRecord: backup });
      if (saveResult?.error) throw new Error(`Save failed: ${saveResult.error}`);
      console.log('Restored.');
    });
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  console.error('UNEXPECTED ERROR:', err?.message || err);
  process.exitCode = 1;
});
