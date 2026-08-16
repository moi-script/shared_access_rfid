import { FilterQuery, Types } from 'mongoose';
import { AttendanceModel, IAttendance } from '../attendance/attendance.model';
import { ScanLogModel, IScanLog } from '../scan/scan.model';
import { ApiError } from '../../utils/ApiError';
import { parseLocalDateRange } from '../../utils/dateRange';

interface AttendanceReportQuery {
  from?: string;
  to?: string;
  status?: string;
}

interface GateActivityQuery {
  gate_id?: string;
  from?: string;
  to?: string;
}

interface AnomalyQuery {
  from?: string;
  to?: string;
}

export const reportService = {
  async attendance(query: AttendanceReportQuery) {
    const filter: FilterQuery<IAttendance> = {};
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      const range: Record<string, string> = {};
      if (query.from) range.$gte = query.from;
      if (query.to) range.$lte = query.to;
      filter.date = range;
    }
    const rows = await AttendanceModel.find(filter).sort({ date: -1 }).lean();
    return { count: rows.length, rows };
  },

  async gateActivity(query: GateActivityQuery) {
    const match: FilterQuery<IScanLog> = {};
    if (query.gate_id) {
      if (!Types.ObjectId.isValid(query.gate_id)) {
        throw new ApiError('VALIDATION_ERROR', 'invalid gate_id');
      }
      match.gate_id = new Types.ObjectId(query.gate_id) as unknown as IScanLog['gate_id'];
    } else {
      // Manual-override rows have no gate. Without this they aggregate into a
      // null bucket that reads as a phantom gate.
      match.gate_id = { $ne: null } as unknown as IScanLog['gate_id'];
    }
    if (query.from || query.to) {
      // Local-day boundaries, exclusive `to` — same defect and fix as
      // scan.service.ts's listLogs; see utils/dateRange.ts.
      match.scan_time = parseLocalDateRange(query.from, query.to);
    }
    const rows = await ScanLogModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: { gate_id: '$gate_id', access_result: '$access_result' },
          count: { $sum: 1 },
        },
      },
    ]);
    return { count: rows.length, rows };
  },

  /**
   * Every scan the passback system considers abnormal: refused repeat entries,
   * exits with no matching entry, occupancy writes that failed on exit,
   * superadmin overrides, and exits the gate opened on a LAPSED registration.
   * Capped at 500 rows — unlike the older reports here, this one is bounded on
   * purpose.
   */
  async anomalies(query: AnomalyQuery) {
    const match: Record<string, unknown> = {
      $or: [
        {
          reason: {
            $in: ['already_inside', 'exit_without_entry', 'manual_override', 'occupancy_unavailable'],
          },
        },
        {
          // The lapsed-egress override in scan.service.tap: a deactivated or
          // expired pass whose EXIT was granted anyway, because a stuck exit
          // gate is a safety problem and a refused exit strands the occupancy
          // row (see the long comment there). The barrier opened for a
          // registration that was refused, which is exactly what an auditor
          // needs to see.
          //
          // `access_result: 'granted'` is load-bearing, not decoration. These
          // four reasons are the ordinary vocabulary of DENIED taps — every
          // refused inactive card at every gate carries one — and matching on
          // reason alone would bury the handful of real anomalies under every
          // routine denial in the window, past the 500-row cap.
          access_result: 'granted',
          reason: {
            $in: ['inactive_id', 'vehicle_expired', 'no_vehicle_registered', 'multiple_vehicles'],
          },
        },
      ],
    };
    if (query.from || query.to) {
      // Local-day boundaries, exclusive `to` — same defect and fix as
      // scan.service.ts's listLogs; see utils/dateRange.ts.
      match.scan_time = parseLocalDateRange(query.from, query.to);
    }

    const rows = await ScanLogModel.aggregate([
      { $match: match },
      { $sort: { scan_time: -1 } },
      { $limit: 500 },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gate' } },
      { $lookup: { from: 'users', localField: 'actor_user_id', foreignField: '_id', as: 'actor' } },
      {
        $project: {
          _id: 0,
          scan_time: 1,
          reason: 1,
          direction: 1,
          access_result: 1,
          entity_type: 1,
          rfid_uid: 1,
          name: {
            $ifNull: [
              { $arrayElemAt: ['$person.full_name', 0] },
              { $arrayElemAt: ['$vehicle.plate_number', 0] },
            ],
          },
          gate: {
            $cond: [
              { $eq: ['$reason', 'manual_override'] },
              'Manual override',
              { $ifNull: [{ $arrayElemAt: ['$gate.name', 0] }, 'Unknown gate'] },
            ],
          },
          actor: { $arrayElemAt: ['$actor.username', 0] },
        },
      },
    ]);
    // The $limit: 500 above can silently hide rows: cheap-to-generate
    // exit_without_entry activity can push an override past the cap without
    // destroying it (a `from`/`to` range still recovers it), so an operator
    // reading only `count` cannot tell "500" from "at least 500". Mirror the
    // roster-truncation fix already shipped on the frontend: report the true
    // total alongside the capped rows and flag when they diverge.
    const total = await ScanLogModel.countDocuments(match);
    return { count: rows.length, total, truncated: total > rows.length, rows };
  },
};
