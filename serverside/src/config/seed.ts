import bcrypt from 'bcrypt';
import { connectDB, disconnectDB } from './db';
import { env } from './env';
import { UserModel } from '../modules/users/users.model';
import { GateModel } from '../modules/gates/gates.model';
import { ROLES } from '../constants/roles';

const GATES = [
  { name: 'Main Entrance', type: 'person' as const, direction: 'entry' as const, location: 'Front Building Gate A' },
  { name: 'Side Gate', type: 'person' as const, direction: 'exit' as const, location: 'South Wing Gate B' },
  { name: 'Parking Entrance', type: 'vehicle' as const, direction: 'entry' as const, location: 'Parking Lot Entry' },
  { name: 'Parking Exit', type: 'vehicle' as const, direction: 'exit' as const, location: 'Parking Lot Exit' },
];

async function seed(): Promise<void> {
  await connectDB();

  // Admin (idempotent)
  const existingAdmin = await UserModel.findOne({ username: env.ADMIN_USERNAME });
  if (existingAdmin) {
    console.log(`[seed] superadmin '${env.ADMIN_USERNAME}' already exists — skipping`);
  } else {
    const password_hash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
    await UserModel.create({
      username: env.ADMIN_USERNAME,
      password_hash,
      role: ROLES.SUPERADMIN,
      person_id: null,
      must_change_password: true,
      is_active: true,
    });
    console.log(`[seed] created superadmin '${env.ADMIN_USERNAME}'`);
  }

  // Gates (idempotent by name)
  for (const g of GATES) {
    // Upsert rather than skip: `direction` is new and required, so gates
    // created before this field existed must be backfilled here.
    await GateModel.updateOne({ name: g.name }, { $set: g }, { upsert: true });
    console.log(`[seed] gate '${g.name}' ready (${g.type}/${g.direction})`);
  }

  await disconnectDB();
  console.log('[seed] done');
}

seed().catch(async (err) => {
  console.error('[seed] failed', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
