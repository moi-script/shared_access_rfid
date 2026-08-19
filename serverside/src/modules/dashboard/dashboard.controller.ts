import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { dashboardService } from './dashboard.service';
import { liveHub } from './liveHub';

export const dashboardController = {
  get: asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new ApiError('UNAUTHORIZED');
    const data = await dashboardService.get({ role: req.user.role, personId: req.user.personId });
    sendSuccess(res, data);
  }),

  live: asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await dashboardService.liveView());
  }),

  /**
   * The push half of the live Overview. Holds the connection open and writes
   * one frame per coalesced tap burst, so a card moves within a heartbeat of
   * somebody tapping instead of on the client's next timer.
   *
   * Deliberately NOT wrapped in sendSuccess: this response never "completes",
   * so the envelope every other endpoint returns has nowhere to go. Clients
   * read `event:`/`data:` frames instead.
   */
  stream: asyncHandler(async (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // `no-transform` is the load-bearing half. A proxy that gzips or
      // otherwise rewrites this body buffers it, and a buffered stream is a
      // stream that delivers nothing until it is too late to matter.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx-family proxies (Render's included) buffer proxied responses by
      // default; this is the documented opt-out.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Node kills a socket that produces nothing for the server's timeout. The
    // heartbeat should be what keeps this alive, not luck about which timeout
    // is shorter.
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    // Registered BEFORE the snapshot is awaited: a client that disconnects
    // during that query would otherwise never be removed from the hub.
    req.on('close', () => liveHub.unsubscribe(res));

    await liveHub.subscribe(res);
  }),
};
