import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { actorOf } from '../../utils/authority';
import { vehicleService } from './vehicles.service';
import { vehiclePhotoService } from './vehiclePhotos.service';

export const vehicleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await vehicleService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.create(req.body, actorOf(req)), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.update(req.params.id, req.body, actorOf(req)));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.setStatus(req.params.id, req.body.status, actorOf(req)));
  }),

  uploadPhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehiclePhotoService.upload(req.params.id, actorOf(req), req.file), 201);
  }),
  getPhoto: asyncHandler(async (req: Request, res: Response) => {
    const photo = await vehiclePhotoService.get(req.params.id);
    const etag = `W/"${photo.updatedAt.getTime()}-${photo.byte_size}"`;
    // A gate terminal re-requests the same vehicles all day.
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.status(200).send(photo.data);
  }),
  deletePhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehiclePhotoService.remove(req.params.id, actorOf(req)));
  }),
};
