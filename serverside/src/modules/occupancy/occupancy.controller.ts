import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { occupancyService } from './occupancy.service';

export const occupancyController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await occupancyService.list(req.query as Record<string, unknown>);
    sendSuccess(res, items, 200, meta);
  }),

  clear: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    sendSuccess(res, await occupancyService.clear(req.params.id, req.user.userId), 200);
  }),
};
