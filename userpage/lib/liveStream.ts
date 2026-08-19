"use client";

import { API_BASE, getToken } from "@/lib/auth";
import type { LiveOverview } from "@/components/admin/types";

export type LiveStatus =
  /** No connection yet, or one is being established. */
  | "connecting"
  /** Frames are arriving. Consumers should stop any polling fallback. */
  | "open"
  /** Dropped; a retry is scheduled. Consumers should poll meanwhile. */
  | "reconnecting"
  /** The token is dead. Consumers should send the user to /login. */
  | "unauthorized";

export interface LiveEvent {
  type: "snapshot" | "update";
  data: LiveOverview;
}

interface Subscriber {
  onEvent: (e: LiveEvent) => void;
  onStatus: (s: LiveStatus) => void;
}

/**
 * One shared Server-Sent Events connection to /dashboard/live/stream.
 *
 * Module-level rather than per-hook so that two screens watching the same
 * feed — Overview and Records — cost one connection between them, not one
 * each. Ref-counted: the socket opens on the first subscriber and closes on
 * the last, so nothing is held open for a console sitting on the Register tab.
 *
 * Uses fetch + ReadableStream rather than the EventSource API. EventSource
 * cannot send an Authorization header, and this app's access token is a Bearer
 * in localStorage (only the refresh token is a cookie). The usual workaround —
 * putting the token in the query string — writes a live credential into the
 * host's request logs and every proxy along the way, which is not a trade
 * worth making for an API the browser already supports.
 */

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const subscribers = new Set<Subscriber>();

let controller: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let status: LiveStatus = "connecting";

function setStatus(next: LiveStatus): void {
  if (status === next) return;
  status = next;
  for (const s of [...subscribers]) s.onStatus(next);
}

function emit(e: LiveEvent): void {
  for (const s of [...subscribers]) s.onEvent(e);
}

/** Parses one complete SSE frame. Comment frames (`: ping`) yield null. */
function parseFrame(raw: string): LiveEvent | null {
  if (raw.startsWith(":")) return null;
  const type = /^event: (.+)$/m.exec(raw)?.[1];
  const data = /^data: (.+)$/m.exec(raw)?.[1];
  if (!data || (type !== "snapshot" && type !== "update")) return null;
  try {
    return { type, data: JSON.parse(data) as LiveOverview };
  } catch {
    // A truncated or malformed frame is not worth tearing the connection down
    // over — the next tap sends a complete one.
    return null;
  }
}

function scheduleRetry(): void {
  if (subscribers.size === 0 || retryTimer) return;
  setStatus("reconnecting");
  // Exponential with a ceiling: a backend that is down for ten minutes should
  // not be met with ten minutes of per-second retries from every open console.
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (subscribers.size === 0 || controller) return;

  const token = getToken();
  const ac = new AbortController();
  controller = ac;

  try {
    const res = await fetch(`${API_BASE}/dashboard/live/stream`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
      signal: ac.signal,
    });

    if (res.status === 401) {
      // Retrying cannot fix an expired token, and a console silently retrying
      // forever looks identical to one that is merely offline.
      setStatus("unauthorized");
      controller = null;
      return;
    }
    if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Only now, with a readable body in hand. Reporting "open" off the status
    // code alone would tell consumers to stop polling before a single frame
    // has actually arrived.
    retryAttempt = 0;
    setStatus("open");

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line, and a chunk can split one in
      // half — hold the remainder in the buffer rather than parsing a partial.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (frame) emit(frame);
      }
    }

    // A clean end-of-stream still means no more updates: the server restarted
    // or a proxy timed the connection out. Reconnect the same as an error.
    controller = null;
    scheduleRetry();
  } catch (err) {
    controller = null;
    // An abort is our own teardown, not a failure — never retry into it.
    if (ac.signal.aborted) return;
    if (process.env.NODE_ENV !== "production") {
      console.warn("[liveStream] disconnected", err);
    }
    scheduleRetry();
  }
}

function teardown(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
  retryAttempt = 0;
  status = "connecting";
}

/**
 * Subscribes to the live feed. Returns an unsubscribe function.
 *
 * `onStatus` fires immediately with the current status so a subscriber joining
 * an already-open stream does not sit in "connecting" until something changes.
 */
export function subscribeLive(
  onEvent: (e: LiveEvent) => void,
  onStatus: (s: LiveStatus) => void,
): () => void {
  const sub: Subscriber = { onEvent, onStatus };
  subscribers.add(sub);
  onStatus(status);

  if (!controller && !retryTimer) void connect();

  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) teardown();
  };
}
