import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { reportService } from './reports.service';

export const reportController = {
  attendance: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.attendance(req.query as Record<string, string>));
  }),
  gateActivity: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.gateActivity(req.query as Record<string, string>));
  }),
  anomalies: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await reportService.anomalies(req.query as Record<string, string>));
  }),
};
