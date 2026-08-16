import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { scanService } from './scan.service';

export const scanController = {
  tap: asyncHandler(async (req: Request, res: Response) => {
    // A device key names its own gate; a JWT caller supplies one in the body.
    const input = req.gate
      ? {
          rfid_uid: req.body.rfid_uid as string,
          gate_id: req.gate.gateId,
          direction: req.gate.direction,
        }
      : req.body;
    const result = await scanService.tap(input);
    sendSuccess(res, result, 200); // always 200 — denied is a business outcome
  }),
  logs: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
