import { env } from './env';

// Every address range RFC 1918 and RFC 5735 reserve for private use, plus the
// loopback block. Nothing in here is routable from the internet, which is the
// only reason ALLOW_LAN_ORIGINS can safely wave through a host it has never
// been told about. Anchored end to end: an unanchored test would accept
// `192.168.1.2.attacker.com`, a public host whose name merely contains a
// private-looking prefix.
const PRIVATE_HOSTNAME =
  /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[::1\])$/;

export function isPrivateNetworkOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return PRIVATE_HOSTNAME.test(url.hostname);
}

/**
 * Decides the Access-Control-Allow-Origin for one request.
 *
 * Reports "not allowed" as `cb(null, false)` rather than an error, matching
 * what the plain array form of `cors({ origin: [...] })` does: the header is
 * simply omitted and the browser refuses the response. Passing an Error
 * instead would turn a disallowed origin into a 500 for non-browser callers
 * that are not subject to CORS at all.
 */
export function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void
): void {
  // Same-origin requests, curl and the verify:* harnesses send no Origin at
  // all. CORS has nothing to say about them.
  if (!origin) return cb(null, true);
  if (env.ALLOWED_ORIGINS_LIST.includes(origin)) return cb(null, true);
  if (env.ALLOW_LAN_ORIGINS && isPrivateNetworkOrigin(origin)) return cb(null, true);
  return cb(null, false);
}
