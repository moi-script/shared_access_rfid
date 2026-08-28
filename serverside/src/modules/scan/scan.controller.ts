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
  gadgetSession: asyncHandler(async (req: Request, res: Response) => {
    // Gate callers have their gate on the key; JWT callers name it in the body.
    const gate_id = req.gate ? String(req.gate.gateId) : String(req.body.gate_id);
    sendSuccess(
      res,
      await scanService.closeGadgetSession({
        gate_id,
        person_id: req.body.person_id,
        missing_gadget_ids: req.body.missing_gadget_ids,
      })
    );
  }),
  logs: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
