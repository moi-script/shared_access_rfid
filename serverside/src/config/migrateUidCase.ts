/**
 * One-off, idempotent uppercase of every stored `rfid_uid`.
 *
 * Run with: npm run migrate:uid-case
 *
 * WHY THIS EXISTS
 * ---------------
 * Normalization was introduced at BOTH rfid_uid boundaries: the registration
 * schemas (persons, vehicles, gadgets, vehicle applications) uppercase what
 * they store, and scan.schema.ts uppercases what a tap presents. Every lookup
 * behind those boundaries is exact-match — persons/vehicles/gadgets repos and
 * blockedCardRepo.isBlocked all do a plain equality find.
 *
 * That leaves the rows written BEFORE the change. A person registered as
 * `a1b2c3` still holds `a1b2c3`; the gate now asks for `A1B2C3` and gets
 * nothing back. Stated plainly: any row left lowercase is a card that no
 * longer opens a gate. In `blockedcards` the failure runs the other way — a
 * lost card blocked as `a1b2c3` stops matching an uppercase re-registration
 * attempt, so a retired card becomes re-registrable, which is the exact
 * escape hatch the blocklist exists to close.
 *
 * Writes through the native collection driver rather than the Mongoose models
 * on purpose, matching migrateVehicleTypes.ts: this repairs a stored value
 * across four unrelated models, and going through the driver keeps one code
 * path instead of four model-shaped ones.
 *
 * Idempotent by construction: it matches only documents whose `rfid_uid` is
 * present, non-null, and NOT already equal to its own uppercase form, so a
 * second run matches nothing and reports zero per collection — a visible
 * no-op rather than an ambiguous silence.
 *
 * `vehicleapplications.rfid_uid` is deliberately left alone. It is paperwork:
 * nothing taps it and nothing looks it up: approving an application copies the
 * (now normalized) submitted value into the Vehicle row, which IS migrated
 * here.
 */
import mongoose from 'mongoose';
import { connectDB } from './db';

// Collection names, not model names — this script bypasses Mongoose models by
// design (see the file comment). Verified against the live database: Person ->
// `people`, Vehicle -> `vehicles`, Gadget -> `gadgets`, BlockedCard ->
// `blockedcards` (mongoose's default pluralization, no explicit override).
const COLLECTIONS = ['people', 'vehicles', 'gadgets', 'blockedcards'];

async function main(): Promise<void> {
  await connectDB();
  console.log(`[migrate:uid-case] uppercasing rfid_uid across ${COLLECTIONS.join(', ')}`);

  let grandTotal = 0;
  for (const name of COLLECTIONS) {
    const collection = mongoose.connection.collection(name);

    // Matches only rows that actually need the change. `$expr` is what lets
    // the filter compare a field to a function OF THAT SAME field; a plain
    // query operator cannot express "not already uppercase".
    const candidates = {
      rfid_uid: { $exists: true, $ne: null },
      $expr: { $ne: ['$rfid_uid', { $toUpper: '$rfid_uid' }] },
    };

    const pending = await collection.countDocuments(candidates);

    // A pipeline update, so each document uppercases its OWN value in a single
    // pass. The alternative — reading every UID into Node and issuing one
    // write per row — is the same result with N round trips and a window in
    // which half the collection is migrated.
    const result = await collection.updateMany(candidates, [
      { $set: { rfid_uid: { $toUpper: '$rfid_uid' } } },
    ]);

    console.log(`  ${name}: ${result.modifiedCount} document(s) updated (${pending} matched)`);
    grandTotal += result.modifiedCount;

    // Anything still lowercase after the pass is a row the pipeline could not
    // rewrite — a non-string rfid_uid, most likely. Report it rather than let
    // it read as a successful run.
    const leftover = await collection.countDocuments(candidates);
    if (leftover > 0) {
      console.log(`  WARNING ${name}: ${leftover} document(s) still hold a non-uppercase rfid_uid`);
    }
  }

  console.log(`\n[migrate:uid-case] done. ${grandTotal} document(s) updated in total.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate:uid-case] failed', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
