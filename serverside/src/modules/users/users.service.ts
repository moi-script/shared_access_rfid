import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { userRepo, UserListQuery } from './users.repository';
import { IUser, UserModel } from './users.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Role, bulkEligibleRoles, personDomain, WRITE_DOMAINS } from '../../constants/roles';
import { Actor, assertCanActOn, assertCanCreateRole, assertCanWrite } from '../../utils/authority';
import { personRepo } from '../persons/persons.repository';
import { PersonModel } from '../persons/persons.model';

const BCRYPT_ROUNDS = 12;

interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
  person_id?: string | null;
}

export const userService = {
  async list(query: Record<string, string | undefined>) {
    const p = getPagination(query);
    const filter = await userRepo.buildFilter({
      type: query.type,
      department_section: query.department_section,
      search: query.search,
    });
    const { items, total } = await userRepo.findPaginatedWithPerson(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async create(input: CreateUserInput, actor: Actor) {
    // Rank: never at or above your own level. On create there is no target
    // row, so the rule applies to the requested role.
    assertCanCreateRole(actor, input.role);

    // Domain: a login is created FOR a person. Rank alone would let OSS
    // create student logins — rank-legal, domain-illegal.
    if (input.person_id) {
      const person = await personRepo.findById(String(input.person_id));
      if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
      assertCanWrite(actor, personDomain(person.type));
    }

    const existing = await userRepo.findByUsername(input.username);
    if (existing) throw new ApiError('DUPLICATE_USERNAME');

    const password_hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const created = await userRepo.create({
      username: input.username,
      password_hash,
      role: input.role,
      person_id: (input.person_id as unknown as IUser['person_id']) ?? null,
      must_change_password: true,
      is_active: true,
    });
    return {
      id: String(created._id),
      username: created.username,
      role: created.role,
      person_id: created.person_id,
      must_change_password: created.must_change_password,
    };
  },

  async resetPassword(id: string, password: string, actor: Actor) {
    const target = await userRepo.findById(id);
    if (!target || target.deleted_at) throw new ApiError('NOT_FOUND', 'User not found');
    // Rank only: no Person is written, so no domain check applies. This
    // asymmetry vs. setStatus/softDelete is deliberate, per the spec.
    assertCanActOn(actor, target);

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await userRepo.updateById(id, {
      password_hash,
      must_change_password: true,
      refreshTokenHash: null,
    });
    if (!updated) throw new ApiError('NOT_FOUND', 'User not found');
    return { id, updated: true };
  },

  /**
   * Deletion is a one-way deactivation that also hides the account from every list.
   *
   * Person first, then user — same fail-safe rule as setStatus. If the second write is
   * lost, the card is already refused at the gate and only the login survives.
   */
  async softDelete(id: string, actor: Actor) {
    const target = await userRepo.findById(id);
    if (!target || target.deleted_at) throw new ApiError('NOT_FOUND', 'User not found');
    await this.assertCanActOnPersonBackedAccount(actor, target);

    if (target.person_id) {
      await personRepo.updateById(String(target.person_id), { status: 'inactive' });
    }

    const now = new Date();
    await userRepo.updateById(id, {
      is_active: false,
      deleted_at: now,
      deactivated_at: now,
      deactivated_by: new Types.ObjectId(actor.id),
      refreshTokenHash: null,
    });

    return { id, deleted: true };
  },

  /**
   * The status toggle and soft-delete write BOTH the User and its Person, so
   * both rules apply and DOMAIN WINS over rank: HR outranks a student account
   * but may not write a person:student record, so HR cannot deactivate a
   * student. See the ruling in the spec's cross-rule interaction 1.
   *
   * A genuinely dangling person_id (User pointing at a Person row that no
   * longer exists at all) has no gate side to write, so rank alone governs.
   * Do NOT fail closed on it — that turns a data-integrity problem into what
   * looks like a permissions bug.
   *
   * personRepo.findById is deleted-filtered (see persons.repository.ts), so
   * it returns null for BOTH a dangling reference and a soft-deleted person —
   * those are not the same case. A soft-deleted person still has a domain;
   * the cascade in personService.softDelete deliberately deactivated this
   * exact login, and skipping the domain guard here would let HR or a
   * registrar reactivate a deleted student's account, which they could never
   * touch while that student was still on the roster. A raw PersonModel
   * lookup with an explicit deleted_at branch is what tells the two cases
   * apart; only a superadmin may act on a person-backed account whose person
   * was soft-deleted.
   */
  async assertCanActOnPersonBackedAccount(actor: Actor, target: IUser): Promise<void> {
    assertCanActOn(actor, target);
    if (!target.person_id) return;
    const person = await PersonModel.findById(String(target.person_id)).lean();
    if (!person) return; // genuinely dangling reference: no gate side, rank alone governs
    if (person.deleted_at) {
      if (actor.role !== 'superadmin') {
        throw new ApiError(
          'FORBIDDEN',
          "This person's account was deleted by an administrator; ask a superadmin to restore it."
        );
      }
      return;
    }
    assertCanWrite(actor, personDomain(person.type));
  },

  /**
   * One toggle, two effects: the login and the RFID card.
   *
   * Deactivating clears refreshTokenHash so an existing session cannot be
   * refreshed back into life, and stamps who did it. Reactivating clears the
   * stamp. Task 8's bulk path applies these same rules.
   *
   * Write order is deliberate, not incidental, and it is conditional on
   * `active`: the gate is the first thing closed and the last thing opened.
   * There is no transaction here (a standalone dev Mongo has no replica set),
   * so a partial failure between the two writes is possible — the order
   * decides which side that failure leaves safe.
   *   - Deactivating: write Person first, then User. If the User write never
   *     happens, the card is already refused at the gate even though the
   *     login still works — inconvenient, but safe.
   *   - Reactivating: write User first, then Person. If the Person write
   *     never happens, the login works but the gate stays shut — safe in the
   *     same direction.
   */
  async setStatus(id: string, active: boolean, actor: Actor) {
    const target = await userRepo.findById(id);
    if (!target || target.deleted_at) throw new ApiError('NOT_FOUND', 'User not found');
    await this.assertCanActOnPersonBackedAccount(actor, target);

    const userUpdate = {
      is_active: active,
      refreshTokenHash: active ? undefined : null,
      deactivated_at: active ? null : new Date(),
      deactivated_by: active ? null : new Types.ObjectId(actor.id),
    };

    let person_status: 'active' | 'inactive' | null = null;
    if (target.person_id) {
      person_status = active ? 'active' : 'inactive';
    }

    if (active) {
      // Reactivating: login first, then gate. This order is load-bearing,
      // not stylistic — see the docblock above: if the second write (the
      // Person/gate side) is lost, the login works but the gate stays shut,
      // which is the safe side to fail on. Do not swap these two lines.
      await userRepo.updateById(id, userUpdate);
      if (target.person_id) {
        // Narrowed with deleted_at: null so this can never produce a record
        // that is both deleted_at != null and status: 'active' — a state no
        // screen can explain. assertCanActOnPersonBackedAccount above already
        // denies non-superadmins on a deleted person; this is the last-resort
        // guard against the write itself, including for a superadmin who
        // reactivated the login on purpose but must not silently un-delete
        // the person's gate status as a side effect.
        await PersonModel.updateOne(
          { _id: target.person_id, deleted_at: null },
          { $set: { status: person_status! } }
        );
      }
    } else {
      // Deactivating: gate first, then login — if the login write is lost,
      // the card is already refused, which is the safe side to fail on.
      if (target.person_id) {
        await personRepo.updateById(String(target.person_id), { status: person_status! });
      }
      await userRepo.updateById(id, userUpdate);
    }

    return { id, is_active: active, person_status };
  },

  /**
   * The set a bulk action would touch: the filter, minus accounts at or above
   * the actor's authority level, minus the actor.
   *
   * Exclusions are applied here — server-side — and bulkSetStatus writes
   * against the resulting explicit _id list, never the client's filter, so a
   * crafted request cannot reach a peer. `excluded` is what the UI shows,
   * which is why the rule is applied here rather than pushed into the Mongo
   * query: rows removed by a query predicate never come back and cannot be
   * counted.
   */
  async resolveBulkTargets(query: UserListQuery, actor: Actor) {
    const base = await userRepo.buildFilter(query);
    const candidates = await UserModel.find(base).select('_id role person_id').lean();

    const below = bulkEligibleRoles(actor.role);
    const writable = WRITE_DOMAINS[actor.role];

    // Domain wins here too, and this is the single most damaging hole in the
    // subsystem if it is missed: a role-only predicate would let HR's
    // "Deactivate All" sweep every student on campus, because HR outranks all
    // of them. One query for the candidates' person types, not one per row.
    const personIds = candidates
      .map((c) => c.person_id)
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    // Selects deleted_at too (not filtered out of the query) so a soft-deleted
    // person is still found here — it must be, or it becomes indistinguishable
    // from a genuinely dangling person_id below and falls through the "rank
    // alone governs" branch that dangling refs are deliberately allowed to
    // take. This is what buildFilter's own person lookup cannot do on its
    // own: buildFilter is skipped entirely for an empty filter (`filter: {}`),
    // so an unfiltered bulk action reaches every candidate ONLY through this
    // query, and the exclusion below is the last gate before targets.push.
    const persons = personIds.length
      ? await PersonModel.find({ _id: { $in: personIds } }).select('_id type deleted_at').lean()
      : [];
    const infoById = new Map(persons.map((p) => [String(p._id), p]));

    const targets: string[] = [];
    let excluded = 0;
    for (const c of candidates) {
      if (!below.includes(c.role as Role) || String(c._id) === actor.id) {
        excluded++;
        continue;
      }
      if (c.person_id) {
        const info = infoById.get(String(c.person_id));
        // A soft-deleted person's login is never a bulk candidate, regardless
        // of domain: personService.softDelete deliberately killed this exact
        // login, and only a superadmin may revive it, one at a time, via
        // PATCH /users/:id/status (assertCanActOnPersonBackedAccount above).
        // A dangling person_id (no Person document at all — `info` is
        // undefined) is a different case with no gate side, so rank alone
        // still governs it; do not conflate the two.
        if (info?.deleted_at) {
          excluded++;
          continue;
        }
        if (info && !writable.includes(personDomain(info.type as 'student' | 'staff' | 'employee'))) {
          excluded++;
          continue;
        }
      }
      targets.push(String(c._id));
    }
    return { targets, excluded };
  },

  async bulkPreview(query: UserListQuery, actor: Actor) {
    const { targets, excluded } = await this.resolveBulkTargets(query, actor);
    return { matched: targets.length, excluded };
  },

  /**
   * Same fail-safe write order as `setStatus`: the gate is the first thing
   * closed and the last thing opened. There is no transaction (a standalone
   * dev Mongo has no replica set), so a partial failure between the two
   * `updateMany` calls is possible — the order decides which side is safe.
   *   - Deactivating: write Person (gate) first, then User (login).
   *   - Reactivating: write User (login) first, then Person (gate).
   */
  async bulkSetStatus(active: boolean, query: UserListQuery, actor: Actor) {
    const { targets, excluded } = await this.resolveBulkTargets(query, actor);
    if (targets.length === 0) return { matched: 0, modified: 0, excluded };

    const now = new Date();

    const userUpdate = {
      $set: {
        is_active: active,
        refreshTokenHash: null,
        deactivated_at: active ? null : now,
        deactivated_by: active ? null : new Types.ObjectId(actor.id),
      },
    };

    // Narrow the User write to accounts that actually change state. Without
    // this, a `filter: {}` lockout rewrites deactivated_at/deactivated_by on
    // accounts someone else already deactivated, destroying that audit
    // trail, and modifiedCount stops meaning anything. This narrowing is
    // applied only to the write, never to target resolution: `matched`
    // stays `targets.length` (how many the filter selected, before this
    // idempotency check) so preview and mutation still agree; `modified` is
    // how many rows actually flipped.
    const userFilter = { _id: { $in: targets }, is_active: !active };

    let result: { modifiedCount: number };
    if (active) {
      // Reactivating: login first, then gate. The Person write here must be
      // narrowed the same way the User write is narrowed above — otherwise a
      // person whose card was independently deactivated (e.g. via
      // PATCH /persons/:id/status while the login stayed active) would be
      // silently re-activated just because their *user* row happened to be
      // among the targets and was already active. Query the users matching
      // `userFilter` (i.e. actually flipping is_active: false -> true)
      // *before* the update, and only touch those users' persons.
      const flipping = await UserModel.find(userFilter).select('person_id').lean();
      const personIds = flipping
        .map((u) => u.person_id)
        .filter((p): p is NonNullable<typeof p> => Boolean(p));

      result = await UserModel.updateMany(userFilter, userUpdate);
      if (personIds.length) {
        // Narrowed with deleted_at: null for the same reason as setStatus
        // above — never write status: 'active' onto a soft-deleted person.
        await PersonModel.updateMany(
          { _id: { $in: personIds }, deleted_at: null },
          { $set: { status: 'active' } }
        );
      }
    } else {
      // Deactivating: gate first, then login. Every targeted person is
      // closed regardless of whether their user row already matches —
      // closing a gate that's already closed is harmless, and narrowing it
      // here could leave a gate open. Do not narrow this branch.
      const affected = await UserModel.find({ _id: { $in: targets } })
        .select('person_id')
        .lean();
      const personIds = affected
        .map((u) => u.person_id)
        .filter((p): p is NonNullable<typeof p> => Boolean(p));

      if (personIds.length) {
        await PersonModel.updateMany(
          { _id: { $in: personIds } },
          { $set: { status: 'inactive' } }
        );
      }
      result = await UserModel.updateMany(userFilter, userUpdate);
    }

    return { matched: targets.length, modified: result.modifiedCount, excluded };
  },
};
