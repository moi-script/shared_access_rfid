import { ApiError } from './ApiError';
import { Role, Domain, rankOf, ROLES, WRITE_DOMAINS } from '../constants/roles';
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
 * Peers and superiors are denied on every path — single and bulk alike — with
 * ONE exception: superadmins are peers of each other. See isSuperadminPeer.
 */
export function assertCanActOn(actor: Actor, target: { _id: unknown; role: Role }): void {
  if (String(target._id) === actor.id) {
    throw new ApiError('FORBIDDEN', 'You cannot act on your own account');
  }
  if (isSuperadminPeer(actor.role, target.role)) return;
  if (rankOf(target.role) >= rankOf(actor.role)) {
    throw new ApiError(
      'FORBIDDEN',
      'You cannot act on an account at or above your own authority level'
    );
  }
}

/**
 * The single exception to peer protection: a superadmin acting on a superadmin.
 *
 * Superadmins are peers with identical authority, so one may create another and
 * may also edit, deactivate, reset, or delete one. Both rank guards defer to
 * this ONE predicate rather than each spelling the exception out, so the two
 * can never drift into disagreeing about who a peer is.
 *
 * Written as an explicit `both are superadmin` test rather than as a rank
 * comparison (`rankOf(actor) === 3`) on purpose. A rank test would silently
 * extend the exception to any future role that happens to be given rank 3,
 * turning "superadmins may manage each other" into "the top tier may manage
 * itself" without anyone deciding that. It stays narrow by construction.
 *
 * What this does NOT relax:
 *   - Self-protection. The `target._id === actor.id` check above runs FIRST and
 *     is unaffected: a superadmin still cannot deactivate or delete their own
 *     account, which is what stops the last admin locking everyone out.
 *   - Bulk actions. bulkEligibleRoles() filters to rank < 2 independently of
 *     this, so no sweep can ever touch an admin of any kind — the protection
 *     that keeps one mis-filtered "Deactivate All" from disabling every
 *     superadmin at once.
 *   - Any lower role. hr cannot create or act on hr; oss cannot on oss.
 */
function isSuperadminPeer(actorRole: Role, targetRole: Role): boolean {
  return actorRole === ROLES.SUPERADMIN && targetRole === ROLES.SUPERADMIN;
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
 * POST /users { role: 'superadmin' } used to be 403 for EVERYONE, superadmins
 * included, since rank 3 >= rank 3 — superadmins existed only via `npm run
 * seed` or `npm run grant:superadmin`. That is no longer true: a superadmin
 * may now mint a peer over the API, through the same isSuperadminPeer
 * exception assertCanActOn defers to, so the account can also be managed
 * afterwards rather than being created unreachable. The CLI paths still work
 * and remain the way the FIRST superadmin is created, since minting a peer
 * requires already being one.
 */
export function assertCanCreateRole(actor: Actor, role: Role): void {
  if (isSuperadminPeer(actor.role, role)) return;
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
