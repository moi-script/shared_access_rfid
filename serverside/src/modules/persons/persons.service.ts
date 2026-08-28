import { FilterQuery, Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { personRepo } from './persons.repository';
import { IPerson, PersonModel } from './persons.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, personDomain, WRITE_DOMAINS, type Role } from '../../constants/roles';
import { Actor, assertCanWrite, assertCanActOn, assertCanCreateRole } from '../../utils/authority';
import { userRepo } from '../users/users.repository';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { VehicleModel } from '../vehicles/vehicles.model';
import { GadgetModel } from '../gadgets/gadgets.model';
import { assertUidFree } from '../../utils/assertUidFree';

interface ListQuery {
  page?: string;
  limit?: string;
  type?: string;
  status?: string;
  section?: string;
  search?: string;
}

/**
 * Shared by list(), listDeleted(), and exportCsv() — the search/type/section
 * semantics must stay identical between the active directory and the
 * deleted-people view, or "Show deleted" would silently behave like a
 * different search than the one a superadmin just ran on the main list.
 */
function buildListFilter(query: ListQuery): FilterQuery<IPerson> {
  const filter: FilterQuery<IPerson> = {};
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.section) filter.department_section = query.section;
  if (query.search) {
    const rx = { $regex: query.search, $options: 'i' };
    filter.$or = [{ full_name: rx }, { id_number: rx }];
  }
  return filter;
}

const BCRYPT_ROUNDS = 12;

/**
 * A person's type decides what kind of login they get. Employees share the
 * staff role because RANK treats them identically and there is no separate
 * employee role in ROLES.
 */
function roleForPersonType(type: 'student' | 'staff' | 'employee'): Role {
  return type === 'student' ? ROLES.STUDENT : ROLES.STAFF;
}

export const personService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter = buildListFilter(query);
    const { items, total } = await personRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  /**
   * The counterpart to list(): the only service method that surfaces
   * soft-deleted people, so a superadmin has something to search and
   * restore. Deliberately not a flag on list() — that would mean threading
   * "include deleted" through findPaginated's filter, which is exactly the
   * override notDeleted's spread-last position exists to prevent.
   */
  async listDeleted(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter = buildListFilter(query);
    const { items, total } = await personRepo.findDeletedPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async exportCsv(query: ListQuery): Promise<string> {
    const filter = buildListFilter(query);
    const rows = await personRepo.findAll(filter);
    // status and last_activated_at are appended, not inserted, so an existing
    // spreadsheet or import that reads these columns positionally keeps
    // working. `status` was missing entirely until the activation export was
    // asked for — the CSV described who exists, never whether their card works.
    const header =
      'full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid,' +
      'status,last_activated_at';
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Blank, never a placeholder date, when no activation has been recorded —
    // a fabricated timestamp in this column is indistinguishable from a real
    // one and would quietly corrupt exactly the question the column answers.
    // ISO 8601 so a spreadsheet sorts it as a date rather than as text.
    const isoDate = (d: unknown) => (d ? new Date(d as Date).toISOString() : '');
    const lines = rows.map((r) =>
      [
        r.full_name,
        r.type,
        r.id_number,
        r.department_section,
        r.contact_email,
        r.photo_url,
        r.rfid_uid,
        r.status,
        isoDate(r.last_activated_at),
      ]
        .map(esc)
        .join(',')
    );
    return [header, ...lines].join('\n');
  },

  async sections(type?: string) {
    return personRepo.distinctSections(type);
  },

  async get(id: string) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    return person;
  },

  async create(data: Partial<IPerson> & { password?: string }, actor: Actor) {
    if (!data.type) throw new ApiError('VALIDATION_ERROR', 'type is required');
    assertCanWrite(actor, personDomain(data.type));

    const { password, ...personData } = data;
    const role = roleForPersonType(data.type);
    // Rank check BEFORE any write. Domain authority (above) does not imply the
    // authority to mint a login at that level.
    if (password) assertCanCreateRole(actor, role);

    if (personData.id_number) {
      const dup = await personRepo.findByIdNumber(personData.id_number);
      if (dup) throw new ApiError('DUPLICATE_ID');
    }
    if (personData.rfid_uid) {
      await assertUidFree(personData.rfid_uid);
      // A block enforced only at the barrier would be no block at all: a
      // retired UID could be re-registered here and would then resolve
      // normally at the gate. See scan.service.tap for the other half.
      if (await blockedCardRepo.isBlocked(personData.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    } else {
      personData.status = personData.status ?? 'pending';
    }

    // A person registered WITH a card is created 'active', and that is an
    // activation — the first one. Without this, every newly registered person
    // exports with a blank activation date until someone happens to toggle
    // their status, which would make the column look broken on day one.
    // Defaults to 'active' here for the same reason personSchema does.
    if ((personData.status ?? 'active') === 'active') {
      personData.last_activated_at = new Date();
    }

    // Username availability joins the pre-checks above rather than waiting for
    // the insert, so the realistic conflict fails with nothing written. This
    // codebase uses no transactions (grep startSession/withTransaction: none),
    // so the pre-check IS the atomicity strategy.
    if (password) {
      const takenBy = await userRepo.findByUsername(String(personData.id_number));
      if (takenBy) throw new ApiError('DUPLICATE_USERNAME');
    }

    const person = await personRepo.create(personData);
    if (!password) return { ...person.toObject(), login_created: false };

    try {
      await userRepo.create({
        username: String(personData.id_number),
        password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role,
        person_id: person._id,
        must_change_password: true,
        is_active: true,
      });
    } catch (err) {
      // Only an infrastructure failure reaches here — the username conflict was
      // already ruled out. The person is milliseconds old with nothing
      // referencing it, so a HARD delete is correct: softDelete would leave the
      // id_number and rfid_uid uniqueness slots occupied and block the
      // operator's immediate retry.
      //
      // The delete itself can fail too — the same infrastructure trouble that
      // broke the user insert makes a second write failing quite likely — and
      // if it throws here, that error must not replace the original: it would
      // hide the real cause and leave the orphaned person untraceable. Log the
      // orphan's id and always rethrow the ORIGINAL error.
      try {
        await PersonModel.deleteOne({ _id: person._id });
      } catch (cleanupErr) {
        console.error(
          `[persons] FAILED to roll back orphaned person ${person._id} after a user-create ` +
            'failure — this person has no login and must be cleaned up manually.',
          cleanupErr
        );
      }
      throw err;
    }

    return { ...person.toObject(), login_created: true };
  },

  async import(rows: Partial<IPerson>[], actor: Actor) {
    const skipped: { row: number; reason: string }[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.create(rows[i], actor);
        created++;
      } catch (err) {
        const reason =
          err instanceof ApiError && err.code === 'FORBIDDEN'
            ? 'your role cannot register this person type'
            : err instanceof ApiError && err.code === 'DUPLICATE_ID'
              ? 'id_number already registered'
              : err instanceof ApiError && err.code === 'DUPLICATE_RFID'
                ? 'rfid_uid already registered'
                : (err as { code?: number }).code === 11000
                  ? 'duplicate key (id_number or rfid_uid)'
                  : (err as Error).message;
        skipped.push({ row: i + 1, reason });
      }
    }
    return { created, skipped };
  },

  /**
   * A type change moves a record BETWEEN domains, so both sides are checked.
   *
   * Checking one direction only leaves the other open: check the incoming type
   * alone and a registrar can claim a staff record by retyping it to student;
   * check the existing type alone and a registrar can push a student out to
   * staff, beyond their own reach and into HR's without HR knowing.
   */
  async update(id: string, data: Partial<IPerson>, actor: Actor) {
    const existing = await personRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Person not found');

    assertCanWrite(actor, personDomain(existing.type));
    if (data.type && data.type !== existing.type) {
      assertCanWrite(actor, personDomain(data.type));
    }

    // A superadmin's DELETE /users/:id soft-deletes the linked login AND sets
    // this Person's status to 'inactive' in the same action, closing the
    // gate. assertCanWrite alone does not see that: a registrar/HR account
    // with ordinary write authority over this person's domain could
    // otherwise silently reopen the gate — a card whose login the
    // superadmin killed would work again — while the login itself stays
    // dead and hidden from the Accounts list (buildFilter excludes
    // deleted_at). Only a superadmin may reverse that; anyone else needs to
    // go through a superadmin, who can restore the User first.
    //
    // A merely-deactivated (not deleted) login also needs a rank check, not
    // just a domain check. HR and OSS logins can be person-backed too — only
    // the seeded office accounts happen to be person-less — so without this,
    // an HR account could reactivate a *peer* HR account's Person here even
    // though PATCH /users/:id/status would deny that same actor for
    // assertCanActOn's peer/self rule. Deferring to assertCanActOn whenever a
    // linked User exists makes this route produce the exact same outcome as
    // the /users route the actor would otherwise have to use, closing that
    // gap while leaving every legitimate reactivation of a subordinate's
    // account working.
    if (data.status === 'active' && actor.role !== ROLES.SUPERADMIN) {
      const linkedUser = await userRepo.findByPersonId(id);
      if (linkedUser?.deleted_at) {
        throw new ApiError(
          'FORBIDDEN',
          "This person's account was deleted by an administrator; ask a superadmin to restore it."
        );
      }
      if (linkedUser && !linkedUser.is_active) {
        assertCanActOn(actor, linkedUser);
      }
    }

    // Stamped only on a real transition into 'active'. The `existing.status`
    // test is what keeps a no-op PATCH — a re-save of an already-active person,
    // or an edit to their name that happens to carry status through — from
    // moving a date the status export is read as an audit column. Written into
    // `data` rather than as a second update so the status and its timestamp
    // land in one write and cannot disagree.
    const write: Partial<IPerson> =
      data.status === 'active' && existing.status !== 'active'
        ? { ...data, last_activated_at: new Date() }
        : data;

    const updated = await personRepo.updateById(id, write);
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    return this.update(id, { status }, actor);
  },

  /**
   * The set a bulk status change would touch: the filter, minus people this
   * actor may not write, minus the actor's own record.
   *
   * Modelled on users.service.resolveBulkTargets and load-bearing for the same
   * reason: bulkSetStatus writes against the explicit _id list this returns,
   * never against the client's filter, so a crafted `filter: {}` cannot reach
   * past the exclusions below. `excluded` is counted here rather than pushed
   * into the Mongo query because rows a query predicate removes never come
   * back and cannot be reported to the UI.
   *
   * The person-side equivalent of the users version's most dangerous hole is
   * the domain check: an empty filter matches every person on campus, and
   * without WRITE_DOMAINS applied per row, one "Deactivate All" from a
   * registrar would switch off every staff member and employee too. Registrar
   * holds person:student only, HR holds person:staff and person:employee, so
   * each sweep stops at its own domain.
   *
   * `status` matters because reactivation carries an extra rule that
   * deactivation does not — see the linked-login exclusion below.
   */
  async resolveBulkTargets(
    query: ListQuery,
    actor: Actor,
    status: 'active' | 'inactive'
  ) {
    // deleted_at is pinned here, not inherited: buildListFilter never sets it,
    // and an unfiltered sweep must not resurrect or re-close soft-deleted
    // people. restore() is the only way back for those, and it deliberately
    // returns them at 'inactive'.
    const base: FilterQuery<IPerson> = { ...buildListFilter(query), deleted_at: null };
    const candidates = await PersonModel.find(base).select('_id type').lean();

    const writable = WRITE_DOMAINS[actor.role] ?? [];

    // The actor's own person record, so an HR admin sweeping "all staff"
    // cannot deactivate their own card in the process. Derived from the User
    // row because Actor carries only { id, role } — personId is on the JWT but
    // not on Actor, and inventing a second source of truth for it here is how
    // the two drift apart.
    const self = await userRepo.findById(actor.id);
    const selfPersonId = self?.person_id ? String(self.person_id) : null;

    // Reactivation only. update() refuses a non-superadmin who tries to
    // reactivate a person whose linked login was deleted by a superadmin (or
    // deactivated by someone they cannot act on) — that guard closes the
    // "reopen a gate an administrator shut" hole, and a bulk path that skipped
    // it would be a way around the single-record rule rather than a faster
    // version of it. Deactivation needs no such lookup: closing a gate is
    // never the unsafe direction.
    const guardedLoginPersonIds = new Set<string>();
    if (status === 'active' && actor.role !== ROLES.SUPERADMIN) {
      const candidateIds = candidates.map((c) => c._id);
      const logins = await userRepo.findByPersonIds(candidateIds);
      for (const login of logins) {
        if (login.deleted_at || !login.is_active) {
          guardedLoginPersonIds.add(String(login.person_id));
        }
      }
    }

    const targets: string[] = [];
    let excluded = 0;
    for (const c of candidates) {
      const id = String(c._id);
      if (id === selfPersonId) {
        excluded++;
        continue;
      }
      if (!writable.includes(personDomain(c.type as 'student' | 'staff' | 'employee'))) {
        excluded++;
        continue;
      }
      if (guardedLoginPersonIds.has(id)) {
        excluded++;
        continue;
      }
      targets.push(id);
    }
    return { targets, excluded };
  },

  async bulkPreview(query: ListQuery, actor: Actor, status: 'active' | 'inactive') {
    const { targets, excluded } = await this.resolveBulkTargets(query, actor, status);
    return { matched: targets.length, excluded };
  },

  /**
   * Writes Person.status and nothing else.
   *
   * Deliberately NOT a cascade: vehicles, gadgets, and linked logins are left
   * alone. Deactivating a person already closes both things that matter —
   * scan.service.tap refuses their card at the barrier, and
   * assertOwnerRegistrable refuses any new vehicle or gadget in their name —
   * so sweeping their existing registrations to 'inactive' would add no
   * access control while destroying the state a later reactivation has to
   * restore. users.service.bulkSetStatus cascades because it owns the login
   * side; this one owns the gate side only.
   */
  async bulkSetStatus(status: 'active' | 'inactive', query: ListQuery, actor: Actor) {
    const { targets, excluded } = await this.resolveBulkTargets(query, actor, status);
    if (targets.length === 0) return { matched: 0, modified: 0, excluded };

    // Narrowed to rows that actually change, so `modified` reports the real
    // number of gates opened or closed rather than the size of the sweep.
    // `matched` stays targets.length so preview and mutation agree — the same
    // split users.service.bulkSetStatus draws for the same reason.
    //
    // deleted_at is re-asserted on the write even though resolveBulkTargets
    // already filtered on it: the two queries are separated by several awaits,
    // and a person soft-deleted in between must not come back as 'active'.
    // `status: { $ne: status }` already restricts this to rows that actually
    // flip, so stamping the activation date here is free of the no-op hazard
    // the single-record path in update() has to test for explicitly: a person
    // already active is not in this write at all.
    const result = await PersonModel.updateMany(
      { _id: { $in: targets }, status: { $ne: status }, deleted_at: null },
      { $set: status === 'active' ? { status, last_activated_at: new Date() } : { status } }
    );

    return { matched: targets.length, modified: result.modifiedCount, excluded };
  },

  async reassignRfid(id: string, rfid_uid: string, actor: Actor) {
    const existing = await personRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Person not found');
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    await assertUidFree(rfid_uid, { kind: 'person', id });

    const updated = await this.update(id, { rfid_uid }, actor);
    // Block AFTER the swap succeeds: blocking first would kill the old card
    // even if the reassignment then failed, stranding the person with no
    // working card at all. This is the one place in this feature that fails
    // OPEN on purpose — everywhere else fails closed.
    if (existing.rfid_uid && existing.rfid_uid !== rfid_uid) {
      // block() is a bare create with no retry and no compensation. If it
      // throws here, the old UID is off the person's record (the swap above
      // already succeeded) and off the blocklist too — back in the pool,
      // re-registrable at any of the four issue points, and granted at the
      // barrier once reissued. That is the ruling's forbidden escape hatch,
      // reached by failure rather than by feature. We deliberately do not
      // retry or roll back the swap (see the comment above — that would
      // strand a real person cardless), but a silent failure here must not
      // also be a silent one for whoever operates this system, so it is
      // logged at error level with the UID rather than left to vanish.
      try {
        await blockedCardRepo.block({
          rfid_uid: existing.rfid_uid,
          source: 'card_replaced',
          previous_person_id: existing._id,
          blocked_by: actor.id,
        });
      } catch (err) {
        console.error(
          `[persons] FAILED to block retired card ${existing.rfid_uid} after reassignRfid ` +
            `for person ${id} — this UID is now unassigned AND unblocked, and is re-registrable ` +
            'until manually blocked.',
          err
        );
      }
    }
    return updated;
  },

  /**
   * Write order is load-bearing. There are no transactions (a standalone Mongo
   * has no replica set), so a partial failure is possible and the order decides
   * which side it lands on:
   *   1. vehicles  — crash here: their car is refused, they are still admitted
   *   2. person    — crash here: both cards refused
   *   3. login     — last, because it grants no physical access
   *
   * Every partial failure leaves access MORE restricted, never less. Same rule
   * users.service states for deactivation: the gate is the first thing closed.
   */
  async softDelete(id: string, actor: Actor) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');

    await VehicleModel.updateMany({ owner_person_id: person._id }, { $set: { status: 'inactive' } });
    // Gadgets cascade the same way, and like vehicles they are NOT reactivated
    // by restore() — a restored person comes back inactive and their
    // registrations are re-armed deliberately, not as a side effect.
    //
    // This is not a gate-safety measure: a deleted person cannot tap at all
    // (personRepo.findByRfid is deleted-filtered), so their laptop could never
    // have been displayed anyway. It is a consistency one. Without it the OSS
    // console lists an active laptop registration belonging to somebody the
    // directory says is gone, and it still counts against an allowance that
    // nobody can see.
    await GadgetModel.updateMany({ owner_person_id: person._id }, { $set: { status: 'inactive' } });

    const retiredUid = person.rfid_uid;
    // Block BEFORE the person record releases the UID (reverse of
    // reassignRfid's order, deliberately): the ruling forbids any escape
    // hatch back into the pool for a deleted person's card, so if only one of
    // these two writes can land, it must be this one. A blocked-but-still-
    // assigned UID is the safe direction — blockedCardRepo.isBlocked() is
    // checked before the $unset below ever matters at any issue point or at
    // the barrier (scan.service.tap checks the blocklist first), so the card
    // is already refused either way. The reverse order — $unset then block —
    // would leave a window where a failed block() call has already returned
    // the UID to the pool with nothing on record to stop it being reissued.
    if (retiredUid) {
      await blockedCardRepo.block({
        rfid_uid: retiredUid,
        source: 'person_deleted',
        previous_person_id: person._id,
        blocked_by: actor.id,
      });
    }
    // Raw $set/$unset, not personRepo.updateById: Mongoose's update-casting
    // silently DROPS a key whose value is `undefined` rather than unsetting
    // it (verified against this repo's mongoose version), so `{ rfid_uid:
    // undefined }` would leave the old UID in place — releasing nothing and
    // leaving a deleted person still holding the sparse-unique claim.
    // `$unset` is the only way to actually clear it.
    await PersonModel.findByIdAndUpdate(id, {
      $set: { deleted_at: new Date(), status: 'inactive' },
      $unset: { rfid_uid: 1 }, // release the sparse-unique claim
    });

    const login = await userRepo.findByPersonId(id);
    if (login) {
      await userRepo.updateById(String(login._id), {
        is_active: false,
        refreshTokenHash: null, // an existing session must not be refreshable
        deactivated_at: new Date(),
        deactivated_by: new Types.ObjectId(actor.id),
      });
    }
    return { id, deleted: true };
  },

  /**
   * Restore returns the record, not access. It clears deleted_at and puts the
   * person back at 'inactive' — never 'active' — and deliberately does NOT
   * touch vehicles, the login, or the blocked card: a restored person has no
   * card and must be issued a new one. Restore is not an undo for the card,
   * only for the record.
   */
  async restore(id: string) {
    const person = await PersonModel.findById(id).lean();
    if (!person || !person.deleted_at) throw new ApiError('NOT_FOUND', 'Person not found');

    const updated = await personRepo.updateById(id, { deleted_at: null, status: 'inactive' });
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },
};
