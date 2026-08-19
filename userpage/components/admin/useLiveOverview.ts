"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/auth";
import { subscribeLive, type LiveStatus } from "@/lib/liveStream";
import type { LiveOverview } from "./types";

/**
 * Fallback cadence only. While the stream is up nothing here runs — this is
 * what the console degrades to behind a proxy that eats event-streams, not
 * how it normally works.
 */
const FALLBACK_POLL_MS = 10_000;

export interface LiveState {
  live: LiveOverview | null;
  status: LiveStatus;
}

/**
 * Live Overview data, pushed from the server on every tap.
 *
 * Mount this in OverviewView, NOT in AdminShell. The subscription must end
 * when the admin switches to Register: a feed that outlives the Overview would
 * keep setting state on a screen nobody is looking at, and any re-render it
 * triggers reaches half-typed registration forms. Scoping it to the one view
 * that reads it is what keeps the rest of the console untouched.
 */
export function useLiveOverview(): LiveState {
  const router = useRouter();
  const [live, setLive] = useState<LiveOverview | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");

  // A counter, not a boolean: a fallback poll can still be in flight when the
  // stream comes back. Without this, a slow poll response can land after a
  // fresh pushed frame and walk the count backwards.
  const requestIdRef = useRef(0);

  const poll = useCallback(() => {
    const requestId = ++requestIdRef.current;
    // Cache-buster, as on /occupancy: the browser HTTP cache was observed
    // replaying a stale response for an identical URL.
    apiGet<LiveOverview>(`/dashboard/live?_=${Date.now()}`)
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        setLive(res);
      })
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401) {
          router.replace("/login");
          return;
        }
        // Swallowed on purpose: this is a background refresh of numbers
        // already on screen. The next tick retries.
      });
  }, [router]);

  useEffect(() => {
    return subscribeLive(
      (e) => {
        // Both frame types carry a complete payload, so neither needs merging.
        requestIdRef.current++; // outranks any fallback poll still in flight
        setLive(e.data);
      },
      (s) => {
        setStatus(s);
        if (s === "unauthorized") router.replace("/login");
      },
    );
  }, [router]);

  useEffect(() => {
    // The stream is authoritative while it is up; polling alongside it would
    // reintroduce exactly the request volume this feature exists to remove.
    if (status === "open" || status === "unauthorized") return;

    // One immediate poll so a console that starts up behind a stream-hostile
    // proxy shows real numbers instead of waiting out the first interval.
    poll();
    const id = window.setInterval(() => {
      if (document.hidden) return;
      poll();
    }, FALLBACK_POLL_MS);
    return () => window.clearInterval(id);
  }, [status, poll]);

  return { live, status };
}
