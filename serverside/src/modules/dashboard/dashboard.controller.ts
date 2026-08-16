import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { dashboardService } from './dashboard.service';

export const dashboardController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const data = await dashboardService.get({ role: req.user.role, personId: req.user.personId });
    sendSuccess(res, data);
  }),
};
