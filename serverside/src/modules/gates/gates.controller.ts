import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { gateService } from './gates.service';
import { gateKeyService } from './gateKeys.service';

export const gateController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await gateService.list());
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gateService.get(req.params.id));
  }),
  mintKey: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    sendSuccess(res, await gateKeyService.mint(req.params.id, req.user.userId), 201);
  }),
};
