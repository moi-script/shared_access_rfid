import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { actorOf } from '../../utils/authority';
import { personService } from './persons.service';
import { dashboardService } from '../dashboard/dashboard.service';
import { personPhotoService } from './personPhotos.service';
import { personSignatureService } from './personSignatures.service';

export const personController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await personService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  listDeleted: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await personService.listDeleted(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  export: asyncHandler(async (req: Request, res: Response) => {
    const csv = await personService.exportCsv(req.query);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="persons-${date}.csv"`);
    res.status(200).send(csv);
  }),
  // Full profile (profile + attendance + vehicle + recent scans) — same shape a
  // student sees on their own dashboard, but for any person the admin picks.
  overview: asyncHandler(async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw new ApiError('NOT_FOUND', 'Person not found');
    const data = await dashboardService.userView(req.params.id);
    if (!data.person) throw new ApiError('NOT_FOUND', 'Person not found');
    sendSuccess(res, data);
  }),
  sections: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.sections(req.query.type as string | undefined));
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.create(req.body, actorOf(req)), 201);
  }),
  import: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.import(req.body.rows, actorOf(req)), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.update(req.params.id, req.body, actorOf(req)));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.setStatus(req.params.id, req.body.status, actorOf(req)));
  }),
  reassignRfid: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.reassignRfid(req.params.id, req.body.rfid_uid, actorOf(req)));
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.softDelete(req.params.id, actorOf(req)));
  }),
  restore: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.restore(req.params.id));
  }),
  uploadPhoto: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personPhotoService.upload(req.params.id, actorOf(req), req.file), 201);
  }),
  getPhoto: asyncHandler(async (req: Request, res: Response) => {
    // A gate terminal authenticates by device key and has no req.user; it is
    // allowed any photo.
    const actor = req.gate
      ? null
      : req.user
        ? { role: req.user.role, personId: req.user.personId }
        : null;
    const photo = await personPhotoService.get(req.params.id, actor);
    const etag = `W/"${photo.updatedAt.getTime()}-${photo.byte_size}"`;
    // A gate terminal re-requests the same faces all day.
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
    sendSuccess(res, await personPhotoService.remove(req.params.id, actorOf(req)));
  }),

  uploadSignature: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const actor = { id: req.user.userId, role: req.user.role, personId: req.user.personId };
    sendSuccess(res, await personSignatureService.upload(req.params.id, actor, req.file), 201);
  }),
  getSignature: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const actor = { id: req.user.userId, role: req.user.role, personId: req.user.personId };
    const signature = await personSignatureService.get(req.params.id, actor);
    const etag = `W/"${signature.updatedAt.getTime()}-${signature.byte_size}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', signature.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.status(200).send(signature.data);
  }),
  deleteSignature: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const actor = { id: req.user.userId, role: req.user.role, personId: req.user.personId };
    sendSuccess(res, await personSignatureService.remove(req.params.id, actor));
  }),
};
