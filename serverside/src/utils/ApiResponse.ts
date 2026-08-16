import { Response } from 'express';

export function sendSuccess(
  res: Response,
  data: unknown,
  status = 200,
  meta?: unknown
): Response {
  const body: Record<string, unknown> = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  return res.status(status).json(body);
}
