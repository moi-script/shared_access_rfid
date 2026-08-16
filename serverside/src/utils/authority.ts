import { ApiError } from './ApiError';
import { Role, Domain, rankOf, WRITE_DOMAINS } from '../constants/roles';
import { AuthUser } from '../types';

export interface Actor {
  id: string;
  role: Role;
}

/**
 * Builds the Actor from the authenticated request. `authenticate.ts` sets
 * `req.user = { userId, role, personId }` — the id property is `userId`, not
 * `id`. Shared here so every controller (and every future one) builds the
 * same shape instead of re-deriving it.
 *
 * Typed against a minimal `{ user?: AuthUser }` shape rather than
 * express.Request: express.Request's `user` field only exists via the global
 * augmentation in `src/types/express.d.ts`, which is a module (not a bare
 * ambient .d.ts) and so is only merged into the program when something
 * imports it. Standalone ts-node entry points such as verifyRoles.ts never
 * reach that file through their import graph, so depending on the
 * augmentation here would make this function fail to typecheck outside the
 * full server build. AuthUser already has the exact fields needed.
 */
export function actorOf(req: { user?: AuthUser }): Actor {
  if (!req.user) throw new ApiError('UNAUTHORIZED');
  return { id: req.user.userId, role: req.user.role };
}

/**
 * Two independent rules govern this system and they must not be conflated:
 *
 *   - RANK governs actions on login accounts (User).
 *   - WRITE-DOMAIN governs actions on records (Person, Vehicle, Gadget).
 *
 * They are different rules because a Person is not a User. HR creating Ana's
 * profile and HR creating Ana's login are two separate authorizations, and
 * merging them produces an admin who can mint a peer by way of a profile.
 */

/**
 * May `actor` act on an existing account? Used for status changes, deletion,
 * and password resets.
 *
 * Peers and superiors are denied on every path — single and bulk alike. This
 * deliberately reverses the role-system spec's ruling that a superadmin may
 * individually deactivate another superadmin.
 */
export function assertCanActOn(actor: Actor, target: { _id: unknown; role: Role }): void {
  if (String(target._id) === actor.id) {
    throw new ApiError('FORBIDDEN', 'You cannot act on your own account');
  }
  if (rankOf(target.role) >= rankOf(actor.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'You cannot act on an account at or above your own authority level'
    );
  }
}

/**
 * May `actor` create an account with this role?
 *
 * NOT redundant with assertCanActOn. On create there is no target row to
 * compare against, so the rule must apply to the REQUESTED role. Without this
 * guard an HR admin could POST /users { role: 'hr' } and mint a peer — the
 * exact thing peer protection exists to prevent — and it would sail past a
 * target-based check because no target exists yet.
 *
 * A consequence worth stating: POST /users { role: 'superadmin' } is 403 for
 * EVERYONE, superadmins included, since rank 3 >= rank 3. Superadmins are
 * created by `npm run seed` or `npm run grant:superadmin`, never over the API.
 */
export function assertCanCreateRole(actor: Actor, role: Role): void {
  if (rankOf(role) >= rankOf(actor.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'You cannot create an account at or above your own authority level'
    );
  }
}

/**
 * May `actor` write records of this class?
 *
 * `WRITE_DOMAINS[actor.role]` is `undefined` for a role the table does not
 * recognize, and `undefined.includes(...)` throws a raw TypeError — which
 * surfaces to the client as a 500, not the 403 an authorization failure
 * should be. `?? []` makes an unrecognized role deny every domain instead.
 */
export function assertCanWrite(actor: Actor, domain: Domain): void {
  if (!(WRITE_DOMAINS[actor.role] ?? []).includes(domain)) {
    throw new ApiError('FORBIDDEN', `Your role cannot modify ${domain} records`);
  }
}
