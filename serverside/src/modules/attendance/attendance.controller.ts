import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { attendanceService } from './attendance.service';

export const attendanceController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const { items, meta } = await attendanceService.list(req.query, {
      role: req.user.role,
      personId: req.user.personId,
    });
    sendSuccess(res, items, 200, meta);
  }),
  summary: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await attendanceService.summary(req.params.person_id));
  }),
};
