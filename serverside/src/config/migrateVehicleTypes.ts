/**
 * One-off, idempotent rewrite of the old vehicle_type values to the six-type
 * list in constants/vehicleTypes.ts.
 *
 * Run with: npm run migrate:vehicle-types
 *
 * Writes through the native collection driver rather than the Mongoose model
 * on purpose: the model's enum no longer accepts the OLD values, so a
 * model-level update of a row holding `car` would fail validation on the very
 * documents this script exists to repair.
 *
 * Idempotent because the replacement values are disjoint from the keys it
 * matches — `pickup` is not `car`, so a second run matches nothing. It prints
 * per-collection counts so an already-migrated database reads as a visible
 * no-op instead of an ambiguous silence.
 */
import mongoose from 'mongoose';
import { connectDB } from './db';
import { VEHICLE_TYPES } from '../constants/vehicleTypes';

// motorcycle is absent deliberately: it survives the change unmodified, and
// listing it as motorcycle -> motorcycle would make the run non-idempotent in
// appearance (a nonzero modified count forever) without changing anything.
const MAPPING: Record<string, string> = {
  car: 'pickup',
  tricycle: 'motorcycle',
  other: 'van',
};

// Collection names, not model names — this script bypasses Mongoose models by
// design (see the file comment), so it addresses the collections directly.
const COLLECTIONS = ['vehicles', 'vehicleapplications'];

async function main(): Promise<void> {
  await connectDB();
  console.log(`[migrate:vehicle-types] migrating across ${COLLECTIONS.join(', ')}`);

  let grandTotal = 0;
  for (const name of COLLECTIONS) {
    const collection = mongoose.connection.collection(name);
    let collectionTotal = 0;
    for (const [from, to] of Object.entries(MAPPING)) {
      const result = await collection.updateMany(
        { vehicle_type: from },
        { $set: { vehicle_type: to } }
      );
      if (result.modifiedCount > 0) {
        console.log(`  ${name}: ${from} -> ${to}  (${result.modifiedCount})`);
      }
      collectionTotal += result.modifiedCount;
    }
    console.log(`  ${name}: ${collectionTotal} document(s) updated`);
    grandTotal += collectionTotal;

    // Anything still holding a value outside the new list is a row this
    // mapping did not anticipate. Report it rather than leaving it to fail
    // silently the next time someone edits that record.
    const leftover = await collection
      .aggregate([
        { $match: { vehicle_type: { $nin: [...VEHICLE_TYPES] } } },
        { $group: { _id: '$vehicle_type', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const row of leftover) {
      console.log(`  WARNING ${name}: ${row.count} document(s) still hold '${row._id}'`);
    }
  }

  console.log(`\n[migrate:vehicle-types] done. ${grandTotal} document(s) updated in total.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate:vehicle-types] failed', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
