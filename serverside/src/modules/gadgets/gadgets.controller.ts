import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { actorOf } from '../../utils/authority';
import { gadgetService } from './gadgets.service';
import { gadgetPhotoService } from './gadgetPhotos.service';

export const gadgetController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await gadgetService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetService.create(req.body, actorOf(req)), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetService.update(req.params.id, req.body, actorOf(req)));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetService.setStatus(req.params.id, req.body.status, actorOf(req)));
  }),

  uploadPhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gadgetPhotoService.upload(req.params.id, actorOf(req), req.file), 201);
  }),
  getPhoto: asyncHandler(async (req: Request, res: Response) => {
    const photo = await gadgetPhotoService.get(req.params.id);
    const etag = `W/"${photo.updatedAt.getTime()}-${photo.byte_size}"`;
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
    sendSuccess(res, await gadgetPhotoService.remove(req.params.id, actorOf(req)));
  }),
};
