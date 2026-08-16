import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { scanService } from '../scan/scan.service';

export const logController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
