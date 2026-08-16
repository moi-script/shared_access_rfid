import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { actorOf } from '../../utils/authority';
import { userService } from './users.service';

export const userController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await userService.list(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.create(req.body, actorOf(req)), 201);
  }),
  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.resetPassword(req.params.id, req.body.password, actorOf(req))
    );
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.softDelete(req.params.id, actorOf(req)));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.setStatus(req.params.id, req.body.active, actorOf(req))
    );
  }),
  bulkPreview: asyncHandler(async (req: Request, res: Response) => {
    // `validate(bulkFilterSchema, 'query')` has already parsed req.query into
    // exactly the shape bulkStatusSchema's `filter` admits, so preview and
    // mutation resolve the same filter through the same schema.
    const q = req.query as { type?: string; department_section?: string; search?: string };
    sendSuccess(
      res,
      await userService.bulkPreview(
        { type: q.type, department_section: q.department_section, search: q.search },
        actorOf(req)
      )
    );
  }),
  bulkSetStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.bulkSetStatus(req.body.active, req.body.filter ?? {}, actorOf(req))
    );
  }),
};
