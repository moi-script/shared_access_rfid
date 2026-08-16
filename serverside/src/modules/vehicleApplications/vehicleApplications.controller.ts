import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { actorOf } from '../../utils/authority';
import { vehicleApplicationService } from './vehicleApplications.service';
import { applicationSignatureService } from './applicationSignatures.service';

export const vehicleApplicationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await vehicleApplicationService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleApplicationService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleApplicationService.create(req.body, actorOf(req)), 201);
  }),

  uploadSignature: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await applicationSignatureService.upload(req.params.id, actorOf(req), req.file),
      201
    );
  }),
  getSignature: asyncHandler(async (req: Request, res: Response) => {
    const signature = await applicationSignatureService.get(req.params.id);
    res.setHeader('Content-Type', signature.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(signature.data);
  }),
};
