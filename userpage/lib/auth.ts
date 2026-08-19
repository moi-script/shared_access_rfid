// Client-side auth helpers shared by the login form and the landing pages.

export type Role = "superadmin" | "registrar" | "hr" | "oss" | "staff" | "student";

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  personId: string | null;
  mustChangePassword: boolean;
}

/**
 * Where the client sends its API calls.
 *
 * Deriving from the page's own origin is the DEFAULT, not an opt-in, because
 * the normal case for this project is a source tree copied onto a USB drive
 * and run on a PC whose LAN address nobody knows until the router assigns it.
 * Requiring a variable to be set there means the app is broken on arrival at
 * every new machine, and broken in a way that looks like a server outage
 * rather than a config gap. The Express API runs on the same PC that serves
 * this app, one port over, so the page's own hostname is always the right
 * answer: opened at localhost:5173 the API is localhost:3000, opened at
 * 192.168.1.35:5173 from the gate terminal it is 192.168.1.35:3000.
 *
 * Resolution order:
 *
 * 1. NEXT_PUBLIC_API_BASE_URL — absolute override. The only correct answer
 *    when the API is NOT on the machine serving this page: the Vercel +
 *    Render split, or the nginx/rfid.lab LAN setup where the API is proxied
 *    onto port 443 instead of 3000.
 *
 * 2. The browser's own origin, with the API port swapped in. Needs no
 *    configuration at all — it works with .env.local absent entirely.
 *
 * 3. No window (SSR and prerender). Those run ON the API machine, so loopback
 *    is correct; the browser recomputes case 2 when this module loads
 *    client-side, so nothing derived here reaches a user.
 */
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const port = process.env.NEXT_PUBLIC_API_PORT?.trim() || "3000";

  if (typeof window === "undefined") {
    // Vercel sets VERCEL=1 for every build it runs. There the API is on a
    // different host by definition, so deriving cannot be right and a missing
    // variable is a genuine deploy mistake — one that would otherwise ship a
    // bundle calling https://<the-app>.vercel.app:3000 and fail for real
    // users. Nothing else can distinguish that build from a self-hosted one,
    // since NODE_ENV is "production" for both. Fail the deploy instead.
    if (process.env.VERCEL) {
      throw new Error(
        "NEXT_PUBLIC_API_BASE_URL is not set. A Vercel build needs the deployed " +
          "API origin (e.g. https://ncst-rfid-api.onrender.com/api) at build time; " +
          "set it in the project's Environment Variables and redeploy. Self-hosted " +
          "builds need nothing — they derive the API from the page's own origin.",
      );
    }
    return `http://localhost:${port}/api`;
  }

  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${port}/api`;
}

export const API_BASE = resolveApiBase();

const TOKEN_KEY = "ncst_access_token";
const USER_KEY = "ncst_user";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return (
    window.localStorage.getItem(TOKEN_KEY) ??
    window.sessionStorage.getItem(TOKEN_KEY)
  );
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw =
    window.localStorage.getItem(USER_KEY) ??
    window.sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function storeAuth(
  token: string,
  user: AuthUser,
  remember: boolean,
): void {
  if (typeof window === "undefined") return;
  const store = remember ? window.localStorage : window.sessionStorage;
  store.setItem(TOKEN_KEY, token);
  store.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth(): void {
  if (typeof window === "undefined") return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    store.removeItem(TOKEN_KEY);
    store.removeItem(USER_KEY);
  }
}

/**
 * Rewrites the stored user in whichever store holds it, preserving the
 * remember-me choice. Used after a password change so the client stops
 * believing a change is still required.
 */
export function updateStoredUser(patch: Partial<AuthUser>): void {
  if (typeof window === "undefined") return;
  for (const store of [window.localStorage, window.sessionStorage]) {
    const raw = store.getItem(USER_KEY);
    if (!raw) continue;
    try {
      store.setItem(USER_KEY, JSON.stringify({ ...JSON.parse(raw), ...patch }));
    } catch {
      // A corrupt entry is not worth failing the change over — the next login
      // overwrites it anyway.
    }
  }
}

interface ApiError extends Error {
  code?: string;
  status?: number;
}

/** GET a protected endpoint, attaching the stored access token. */
export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !body || body.success !== true) {
    const failure = body as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

/** GET a paginated list endpoint, returning items plus the total count from meta. */
export async function apiGetList<T>(path: string): Promise<{ items: T[]; total: number }> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T[]; meta?: { pagination?: { total?: number } } }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !body || body.success !== true) {
    const failure = body as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return { items: body.data, total: body.meta?.pagination?.total ?? body.data.length };
}

export async function logout(): Promise<void> {
  const token = getToken();
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
  } catch {
    // Ignore network errors — we clear local state regardless.
  }
  clearAuth();
}

/** POST JSON to a protected endpoint, returning the parsed data envelope. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !parsed || parsed.success !== true) {
    const failure = parsed as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return parsed.data;
}

/** POST multipart form data. The browser sets Content-Type with its own boundary. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
    body: form,
  });
  const body = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;
  if (!res.ok || !body || body.success !== true) {
    const failure = body as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Upload failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

/**
 * Fetches binary content with a credential. An <img src> cannot send an
 * Authorization header, so protected images must come through fetch and be
 * handed to the DOM as an object URL.
 *
 * `extraHeaders` lets a gate terminal pass X-Gate-Key instead of a Bearer token.
 */
export async function authedBlob(
  path: string,
  extraHeaders?: Record<string, string>
): Promise<Blob> {
  const token = getToken();
  // A terminal passes X-Gate-Key in extraHeaders and must NOT also send a
  // Bearer token; every other caller keeps its token unless it explicitly
  // supplies its own Authorization header. Merge, don't replace, so a future
  // caller that passes an unrelated extra header doesn't silently lose auth.
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(token && !extraHeaders?.Authorization ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const err: ApiError = new Error(`Image request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/** PATCH JSON to a protected endpoint, returning the parsed data envelope. */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !parsed || parsed.success !== true) {
    const failure = parsed as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return parsed.data;
}

/** DELETE a protected endpoint, returning the parsed data envelope. No request body. */
export async function apiDelete<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  const parsed = (await res.json().catch(() => null)) as
    | { success: true; data: T }
    | { success: false; code?: string; message?: string }
    | null;

  if (!res.ok || !parsed || parsed.success !== true) {
    const failure = parsed as { code?: string; message?: string } | null;
    const err: ApiError = new Error(failure?.message ?? "Request failed");
    err.code = failure?.code;
    err.status = res.status;
    throw err;
  }
  return parsed.data;
}

/** GET a non-JSON endpoint (e.g. CSV) as a Blob, attaching the access token. */
export async function apiGetBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) {
    const err: ApiError = new Error("Download failed");
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/** Where a role lands after signing in. A forced password change outranks role. */
export function redirectForRole(
  role: Role,
  mustChangePassword?: boolean,
): "/admin" | "/dashboard" | "/change-password" {
  if (mustChangePassword) return "/change-password";
  return role === "superadmin" || role === "registrar" ? "/admin" : "/dashboard";
}
