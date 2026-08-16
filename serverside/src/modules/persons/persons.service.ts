import { FilterQuery, Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { personRepo } from './persons.repository';
import { IPerson, PersonModel } from './persons.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, personDomain, type Role } from '../../constants/roles';
import { Actor, assertCanWrite, assertCanActOn, assertCanCreateRole } from '../../utils/authority';
import { userRepo } from '../users/users.repository';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { VehicleModel } from '../vehicles/vehicles.model';
import { GadgetModel } from '../gadgets/gadgets.model';
// The REPOSITORY, not vehicles.service — vehicles.service.ts already imports
// from the persons side (personRepo), so importing the service here would
// create an import cycle.
import { vehicleRepo } from '../vehicles/vehicles.repository';

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
    const header =
      'full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid';
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.full_name,
        r.type,
        r.id_number,
        r.department_section,
        r.contact_email,
        r.photo_url,
        r.rfid_uid,
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
      const existing = await personRepo.findByRfid(personData.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
      // The reverse of the check in vehicleService.create: a UID belongs to a
      // person OR a vehicle, never both.
      const vehicleWithRfid = await vehicleRepo.findByRfid(personData.rfid_uid);
      if (vehicleWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
      }
      // A block enforced only at the barrier would be no block at all: a
      // retired UID could be re-registered here and would then resolve
      // normally at the gate. See scan.service.tap for the other half.
      if (await blockedCardRepo.isBlocked(personData.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    } else {
      personData.status = personData.status ?? 'pending';
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

    const updated = await personRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    return this.update(id, { status }, actor);
  },

  async reassignRfid(id: string, rfid_uid: string, actor: Actor) {
    const existing = await personRepo.findById(id);
    if (!existing) throw new ApiError('NOT_FOUND', 'Person not found');
    if (await blockedCardRepo.isBlocked(rfid_uid)) throw new ApiError('CARD_BLOCKED');
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');
    const vehicleWithRfid = await vehicleRepo.findByRfid(rfid_uid);
    if (vehicleWithRfid) {
      throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a vehicle');
    }

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
