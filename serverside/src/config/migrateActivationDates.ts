/**
 * One-off, idempotent backfill of Person.last_activated_at for people who
 * predate that field.
 *
 * Run with: npm run migrate:activation-dates
 *
 * WHAT IT WRITES, AND WHY THAT IS AN APPROXIMATION
 * ------------------------------------------------
 * It sets `last_activated_at = createdAt` for every person who is currently
 * 'active' and has no recorded activation date. That is a guess, not a
 * record. Nothing in the database ever stored when these people were
 * activated, so the true date is unrecoverable; createdAt is the closest
 * defensible stand-in, because a person registered with a card is created
 * 'active' and so was activated at creation.
 *
 * For anyone whose status was toggled at some point after registration, the
 * date this writes is EARLIER than the real one. Read the backfilled column
 * as "active at least since", not as "activated on". Rows written from here
 * are indistinguishable from genuinely recorded ones afterwards, which is
 * exactly why this is an explicit, separately-run script and not something
 * the application does on its own.
 *
 * Deliberately does NOT touch:
 *   - inactive or pending people — they have no activation to approximate,
 *     and inventing one would assert an event that never happened
 *   - soft-deleted people — restore() deliberately brings someone back as
 *     'inactive', so a deleted record has no live activation either
 *   - anyone who already has a last_activated_at — a real recorded date is
 *     never overwritten by a guess, which is also what makes a second run a
 *     visible no-op rather than a silent rewrite
 */
import mongoose from 'mongoose';
import { connectDB } from './db';
import { PersonModel } from '../modules/persons/persons.model';

async function main(): Promise<void> {
  await connectDB();
  console.log('[migrate:activation-dates] backfilling Person.last_activated_at from createdAt');

  const candidates = { status: 'active', deleted_at: null, last_activated_at: null };

  const total = await PersonModel.countDocuments(candidates);
  if (total === 0) {
    console.log('  nothing to backfill — every active person already has a recorded date');
    console.log('\n[migrate:activation-dates] done. 0 document(s) updated.');
    await mongoose.disconnect();
    return;
  }
  console.log(`  ${total} active person(s) with no recorded activation date`);

  // A pipeline update, so each document copies its OWN createdAt rather than
  // every row receiving one timestamp computed here in Node. `$$NOW` and a
  // single `new Date()` would both flatten genuinely different registration
  // dates into one, destroying the only signal this backfill has.
  const result = await PersonModel.updateMany(candidates, [
    { $set: { last_activated_at: '$createdAt' } },
  ]);
  console.log(`  ${result.modifiedCount} document(s) updated`);

  // Anything left is a row whose createdAt is missing, which timestamps should
  // make impossible — report it rather than let it read as a successful run.
  const leftover = await PersonModel.countDocuments(candidates);
  if (leftover > 0) {
    console.log(
      `  WARNING ${leftover} active person(s) still have no activation date ` +
        '(no createdAt to copy from)'
    );
  }

  const remainingBlank = await PersonModel.countDocuments({
    deleted_at: null,
    last_activated_at: null,
  });
  console.log(
    `  ${remainingBlank} person(s) still export a blank date — inactive and pending ` +
      'people are left alone on purpose'
  );

  console.log(`\n[migrate:activation-dates] done. ${result.modifiedCount} document(s) updated.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate:activation-dates] failed', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
