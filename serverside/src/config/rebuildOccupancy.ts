/**
 * Rebuilds the occupancy collection from scan_logs.
 *
 * Occupancy is a read-optimised second source of truth; scan_logs is the
 * record of what actually happened. If the two ever disagree — after a restore,
 * a manual edit, or a bug — this reconciles occupancy back to the logs.
 *
 * Only scans since the last reset boundary matter: anything older is expired by
 * definition. Manual-override rows need no special handling; they are granted
 * exits, and replaying them as exits is exactly right.
 *
 * Run with: npm run rebuild:occupancy
 */
import mongoose from 'mongoose';
import { connectDB } from './db';
import { ScanLogModel } from '../modules/scan/scan.model';
import { OccupancyModel } from '../modules/occupancy/occupancy.model';
import { lastResetBoundary } from '../utils/occupancyWindow';

interface Pending {
  entity_type: 'person' | 'vehicle';
  entity_id: mongoose.Types.ObjectId;
  since: Date;
  last_gate_id: mongoose.Types.ObjectId | null;
}

/**
 * Replays granted scans since the last reset boundary and rewrites the
 * occupancy collection to match. Assumes a live DB connection and that
 * `OccupancyModel.init()` has already resolved — callers own connection
 * lifecycle, this function only owns the replay.
 */
export async function rebuildOccupancy(): Promise<{ replayed: number; inside: number }> {
  const boundary = lastResetBoundary(new Date());
  console.log(`[rebuild] replaying granted scans since ${boundary.toISOString()}`);

  const logs = await ScanLogModel.find({
    scan_time: { $gte: boundary },
    access_result: 'granted',
    entity_id: { $ne: null },
  })
    .sort({ scan_time: 1 })
    .lean();

  // Last write wins per entity, in chronological order.
  const inside = new Map<string, Pending>();
  for (const log of logs) {
    if (!log.entity_id) continue;
    const key = `${log.entity_type}:${String(log.entity_id)}`;
    if (log.direction === 'entry') {
      inside.set(key, {
        entity_type: log.entity_type,
        entity_id: log.entity_id,
        since: log.scan_time,
        last_gate_id: log.gate_id ?? null,
      });
    } else {
      inside.delete(key);
    }
  }

  // NOT atomic: MongoDB transactions need a replica set, so this stays a
  // plain delete-then-insert by design. If insertMany below throws after this
  // delete has already succeeded, the collection is left EMPTY — everyone
  // previously marked inside is forgotten, and every card can re-enter
  // without ever having "exited". The catch block in main() below calls this
  // out explicitly so an operator never mistakes a partial failure for a
  // no-op.
  await OccupancyModel.deleteMany({});
  if (inside.size > 0) {
    // Only `inside` rows are written. A missing document already means outside,
    // so writing `outside` rows would bloat the collection to the full roster.
    await OccupancyModel.insertMany(
      [...inside.values()].map((p) => ({
        entity_type: p.entity_type,
        entity_id: p.entity_id,
        state: 'inside' as const,
        since: p.since,
        last_gate_id: p.last_gate_id,
        cleared_by: null,
        cleared_at: null,
      }))
    );
  }

  console.log(`[rebuild] ${logs.length} scans replayed, ${inside.size} entities marked inside`);
  return { replayed: logs.length, inside: inside.size };
}

async function main(): Promise<void> {
  await connectDB();
  // Mongoose builds indexes in the background. deleteMany + insertMany below
  // races that build unless we wait for it: an earlier task in this feature
  // hit duplicates being written before the unique (entity_type, entity_id)
  // index finished, which then failed the index build permanently and
  // silently disabled passback detection. server.ts and the verify harness
  // both wait on this same call for the same reason.
  await OccupancyModel.init();

  try {
    await rebuildOccupancy();
  } catch (err) {
    // deleteMany has already run by the time insertMany can fail, so a
    // failure here is not "nothing happened" — it is "occupancy is now
    // empty". Say so explicitly rather than leaving the operator to guess
    // whether the gate can still be trusted.
    console.error(
      '[rebuild:occupancy] failed after clearing the occupancy collection. ' +
        'Occupancy may now be EMPTY (everyone reads as outside) — re-run ' +
        '`npm run rebuild:occupancy` before trusting the gate again.',
      err
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  await mongoose.disconnect();
}

// Only run the CLI entrypoint when this file is executed directly (`npm run
// rebuild:occupancy`). Without this guard, importing `rebuildOccupancy` as a
// module (as verifyPassback.ts does) would also fire this unconditional
// `main()` call, opening a second competing DB connection and disconnecting
// it out from under whichever caller imported the function.
if (require.main === module) {
  main().catch((err) => {
    console.error('[rebuild:occupancy] failed', err);
    process.exit(1);
  });
}
