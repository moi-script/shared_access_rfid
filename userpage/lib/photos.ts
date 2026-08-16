export type PhotoKind = "internal" | "external" | "none";

/**
 * Decides how a stored photo_url should be rendered.
 *
 * Uploaded photos are stored as a relative API path and need a credential, so
 * they go through AuthedImage. CSV-imported records may hold an absolute URL
 * to somebody else's host, which takes a plain <img> and no credential.
 */
export function classifyPhotoUrl(url?: string | null): { kind: PhotoKind; src: string } {
  const value = (url ?? "").trim();
  if (!value) return { kind: "none", src: "" };
  if (/^https?:\/\//i.test(value)) return { kind: "external", src: value };
  if (value.startsWith("/")) return { kind: "internal", src: value };
  // Anything else (a bare filename, a data: URI from an older record) is not
  // something we can authenticate or trust — treat it as absent.
  return { kind: "none", src: "" };
}

/** Initials for the placeholder shown when there is no photo. */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
