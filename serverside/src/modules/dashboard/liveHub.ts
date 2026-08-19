import { Response } from 'express';
import { dashboardService } from './dashboard.service';

/**
 * In-process fan-out for the superadmin Overview's live stream.
 *
 * Single-instance by design. Render runs this API as one web service (see
 * render.yaml), so a module-level subscriber set reaches every connected
 * console. If this is ever scaled to more than one instance, a tap handled by
 * instance A will not reach a console connected to instance B, and this hub
 * must move behind a shared broker (Mongo change streams or Redis pub/sub)
 * before that happens. The polling fallback in the client is what keeps that
 * a degradation rather than an outage.
 */

/**
 * A burst of taps across several gates must cost one recompute, not one per
 * tap. Long enough to collapse a rush at the barrier, short enough that the
 * card still moves faster than a person can walk through it.
 */
const COALESCE_MS = 250;

/**
 * Proxies drop connections that go quiet. A comment frame is ignored by the
 * SSE parser and exists only to keep the socket warm.
 */
const HEARTBEAT_MS = 25_000;

const subscribers = new Set<Response>();

let coalesceTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

/** True while a broadcast's queries are in flight, so they cannot overlap. */
let broadcasting = false;
/** A tap that arrived DURING a broadcast; its data is not in that payload. */
let dirtyAgain = false;

function write(res: Response, payload: string): boolean {
  try {
    return res.write(payload);
  } catch {
    // A socket that died between the liveness check and this write. Nothing to
    // recover — drop the subscriber and carry on serving the others.
    subscribers.delete(res);
    return false;
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function broadcast(): Promise<void> {
  if (subscribers.size === 0) return;
  broadcasting = true;
  try {
    // ONE query set, serialized ONCE, for every connected console. This is the
    // whole efficiency argument against polling: N consoles used to mean N x
    // 6 query sets per minute; they now share this single read.
    const payload = frame('update', await dashboardService.liveView());
    for (const res of [...subscribers]) write(res, payload);
  } catch (err) {
    // A failed recompute must not kill the stream. The connection stays open,
    // the client keeps the numbers it has, and the next tap tries again — a
    // stale card is a far better outcome than a dropped connection that makes
    // every console fall back to polling.
    console.error('[liveHub] broadcast failed', err);
  } finally {
    broadcasting = false;
    if (dirtyAgain) {
      // A tap landed while the queries above were running, so that tap is not
      // represented in what was just sent. Without this the very last tap of a
      // burst can be the one that never reaches the screen.
      dirtyAgain = false;
      schedule();
    }
  }
}

function schedule(): void {
  if (coalesceTimer) return;
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    void broadcast();
  }, COALESCE_MS);
  // A pending broadcast is not a reason to hold the process open at shutdown.
  coalesceTimer.unref?.();
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const res of [...subscribers]) write(res, ': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

function stopHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

export const liveHub = {
  /**
   * Called from scanService.tap on every tap, granted or denied.
   *
   * Synchronous and non-blocking on purpose: it schedules, it never queries.
   * A gate terminal's response time is the one latency in this system a person
   * physically stands and waits for, and it must not grow to feed a dashboard.
   *
   * With nobody watching this returns immediately and no query runs at all —
   * the reason this costs less than the 10s poll it replaces, not more.
   */
  notifyScan(): void {
    if (subscribers.size === 0) return;
    if (broadcasting) {
      dirtyAgain = true;
      return;
    }
    schedule();
  },

  /**
   * Registers an already-open SSE response and sends it the current state.
   *
   * The snapshot is what lets the client skip a separate priming fetch: by the
   * time this resolves the console has a complete payload, so a fresh
   * connection is never showing dashes.
   */
  async subscribe(res: Response): Promise<void> {
    subscribers.add(res);
    startHeartbeat();
    try {
      write(res, frame('snapshot', await dashboardService.liveView()));
    } catch (err) {
      console.error('[liveHub] snapshot failed', err);
    }
  },

  unsubscribe(res: Response): void {
    subscribers.delete(res);
    if (subscribers.size === 0) stopHeartbeat();
  },

  /**
   * Ends every open stream.
   *
   * server.close() waits for open connections to finish, and an SSE connection
   * never finishes on its own — without this, one connected admin makes a
   * SIGTERM hang until the platform's kill timeout on every single deploy.
   */
  closeAll(): void {
    for (const res of [...subscribers]) {
      try {
        res.end();
      } catch {
        // Already torn down; the delete below is all that is left to do.
      }
    }
    subscribers.clear();
    stopHeartbeat();
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
  },

  /** Exposed for the verification script. */
  subscriberCount(): number {
    return subscribers.size;
  },
};
