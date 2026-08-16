import { FilterQuery, Types } from 'mongoose';
import { vehicleApplicationRepo } from './vehicleApplications.repository';
import { IVehicleApplication } from './vehicleApplications.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { personRepo } from '../persons/persons.repository';
import { vehicleService, assertWithinLimit } from '../vehicles/vehicles.service';
import { vehicleRepo } from '../vehicles/vehicles.repository';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { VehicleType } from '../../constants/vehicleTypes';

interface ListQuery {
  page?: string;
  limit?: string;
  owner_person_id?: string;
  plate_no?: string;
  school_year?: string;
  category?: string;
  linked?: string;
}

export interface CreateApplicationInput {
  category: 'new' | 'renewal';
  applicant_type: 'student' | 'employee';
  vehicle_type: VehicleType;
  owner_person_id: string;
  id_number: string;
  last_name: string;
  first_name: string;
  middle_name?: string;
  year_level?: string;
  school_year: string;
  email?: string;
  mobile_no?: string;
  tel_no?: string;
  permanent_address?: string;
  driver_name?: string;
  driver_license_no?: string;
  lto_cr_no?: string;
  lto_cr_date?: string;
  lto_or_no?: string;
  lto_or_date?: string;
  plate_no: string;
  mv_file_no?: string;
  make: string;
  model?: string;
  year?: string;
  color?: string;
  registered_owner_name: string;
  relationship?: string;
  signed_name: string;
  signed_date: string;
  rfid_uid: string;
  valid_until?: string;
}

export const vehicleApplicationService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IVehicleApplication> = {};
    if (query.owner_person_id) filter.owner_person_id = query.owner_person_id;
    if (query.plate_no) filter.plate_no = query.plate_no;
    if (query.school_year) filter.school_year = query.school_year;
    if (query.category) filter.category = query.category;
    // Because the application is written before the vehicle (see the
    // write-order comment on create() below), a duplicate rfid/plate on
    // submission leaves an orphan application with vehicle_id: null that can
    // never be edited or deleted — by design, applications are immutable.
    // Without this filter there was no way to even find those orphans to
    // investigate them. `linked=false` maps to vehicle_id: null exactly.
    if (query.linked === 'false') filter.vehicle_id = null;
    else if (query.linked === 'true') filter.vehicle_id = { $ne: null };
    const { items, total } = await vehicleApplicationRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async get(id: string) {
    const application = await vehicleApplicationRepo.findById(id);
    if (!application) throw new ApiError('NOT_FOUND', 'Application not found');
    return application;
  },

  /**
   * Write order is load-bearing, not stylistic. There are no transactions (a
   * standalone Mongo has no replica set), so a partial failure is possible and
   * the order decides which side it leaves safe:
   *   1. application  — crash here: paperwork only, nobody gained access
   *   2. vehicle      — gate access begins only now
   *   3. vehicle_id   — system link back onto the application
   *
   * The reverse order would leave a vehicle opening the barrier with no
   * supporting document, which is the failure a pass audit exists to catch.
   * This is the creation-side mirror of the rule users.service states for
   * deactivation: the gate is the first thing closed and the last thing opened.
   */
  async create(input: CreateApplicationInput, actor: Actor) {
    assertCanWrite(actor, 'vehicle');

    const owner = await personRepo.findById(input.owner_person_id);
    if (!owner) throw new ApiError('NOT_FOUND', 'Applicant not found');

    // Pre-check both uniqueness constraints the vehicle write would enforce
    // anyway. The write order below (application, then vehicle) is load-bearing
    // and stays as-is — but without this pre-check, the COMMON failure (a
    // clerk mistypes a plate or RFID that's already registered) writes the
    // application first, then fails on the vehicle insert, leaving an orphan
    // application that can never be edited or deleted (immutable by design).
    // The clerk just resubmits, and the orphan survives forever. This does not
    // close the race — two concurrent submissions for the same plate can still
    // both pass this check and one still fails at the vehicle insert, which is
    // the correct fail-safe behavior for the rare case — it only removes the
    // everyday typo as a cause of application litter. The real unique indexes
    // on vehicles.rfid_uid/plate_number remain what actually prevents a
    // duplicate vehicle from ever being created.
    const existingRfid = await vehicleRepo.findByRfid(input.rfid_uid);
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // Pre-checked here for the same reason as DUPLICATE_RFID above: without
    // it, the application writes first and only the vehicle insert fails,
    // leaving an orphan application that is immutable by design.
    const personWithRfid = await personRepo.findByRfid(input.rfid_uid);
    if (personWithRfid) {
      throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
    }
    // Pre-checked here for the same reason as DUPLICATE_RFID above: the write
    // order below is application-then-vehicle and applications are immutable,
    // so a limit breach discovered at the vehicle insert would leave an orphan
    // application nobody can edit or delete. Identical wording to the check
    // vehicleService.create runs, so a clerk sees one message, not two.
    const activeForOwner = await vehicleRepo.findActiveByOwner(owner._id, new Date());
    assertWithinLimit(activeForOwner, input.vehicle_type, owner.full_name);
    // Pre-checked here too, not just in vehicleService.create below: without
    // this, a blocked UID would write the application first (paperwork
    // survives) and only fail on the vehicle insert, leaving the same kind of
    // orphan application the DUPLICATE_RFID/DUPLICATE_PLATE pre-checks above
    // already exist to avoid.
    if (await blockedCardRepo.isBlocked(input.rfid_uid)) throw new ApiError('CARD_BLOCKED');
    const existingPlate = await vehicleRepo.findByPlate(input.plate_no);
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');

    // `model` is destructured out here (not spread through) because the
    // persisted field is named `vehicle_model` — a bare `model` property
    // collides with mongoose Document's own `.model()` method and fails to
    // typecheck. Mirrors the name Vehicle already uses for the same value,
    // for the same reason (see vehicles.model.ts). The wire-level field
    // (request body, paper form) stays `model`; only the persisted column
    // and this mapping are affected.
    const { model, ...rest } = input;
    const application = await vehicleApplicationRepo.create({
      ...rest,
      owner_person_id: new Types.ObjectId(input.owner_person_id),
      vehicle_model: model,
      lto_cr_date: input.lto_cr_date ? new Date(input.lto_cr_date) : undefined,
      lto_or_date: input.lto_or_date ? new Date(input.lto_or_date) : undefined,
      signed_date: new Date(input.signed_date),
      created_by: new Types.ObjectId(actor.id),
    });

    const vehicle = await vehicleService.create(
      {
        owner_person_id: application.owner_person_id,
        plate_number: input.plate_no,
        rfid_uid: input.rfid_uid,
        vehicle_type: input.vehicle_type,
        make: input.make,
        vehicle_model: input.model,
        color: input.color,
        valid_until: input.valid_until ? new Date(input.valid_until) : nextSchoolYearEnd(),
      },
      actor
    );

    const linked = await vehicleApplicationRepo.linkVehicle(String(application._id), vehicle._id);
    return { application: linked, vehicle };
  },
};
