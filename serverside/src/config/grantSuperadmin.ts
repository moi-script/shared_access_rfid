/**
 * Break-glass superadmin promotion.
 *
 * No superadmin may create a peer over the API (assertCanCreateRole denies
 * rank >= rank, superadmins included), so this script is the only way a second
 * superadmin can exist. It is deliberately outside the API: the rule holds for
 * everyone who is logged in, and promotion requires shell access to the server.
 *
 * Usage: npm run grant:superadmin -- <username>
 */
import { connectDB, disconnectDB } from './db';
import { UserModel } from '../modules/users/users.model';
import { ROLES } from '../constants/roles';

export async function grantSuperadmin(
  username: string
): Promise<{ username: string; promoted: boolean }> {
  const user = await UserModel.findOne({ username, deleted_at: null });
  if (!user) {
    throw new Error(`no active account with username '${username}'`);
  }
  if (user.role === ROLES.SUPERADMIN) {
    return { username, promoted: false };
  }
  const previous = user.role;
  user.role = ROLES.SUPERADMIN;
  await user.save();
  console.log(`[grant] promoted '${username}' from ${previous} to superadmin`);
  return { username, promoted: true };
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    console.error('usage: npm run grant:superadmin -- <username>');
    process.exit(1);
  }
  await connectDB();
  try {
    const result = await grantSuperadmin(username);
    console.log(
      result.promoted
        ? `'${username}' is now a superadmin.`
        : `'${username}' was already a superadmin; nothing to do.`
    );
  } finally {
    await disconnectDB();
  }
}

// Guarded so importing this module (the harness does) does not re-run main and
// crash with MongoClientClosedError. tsconfig targets commonjs and there is no
// "type": "module", so require.main === module is correct here. This exact bug
// was found and fixed in rebuildOccupancy.ts.
if (require.main === module) {
  main().catch((err) => {
    console.error('[grant] failed:', err);
    process.exit(1);
  });
}
