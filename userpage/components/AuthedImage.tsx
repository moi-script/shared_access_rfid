"use client";

import { useEffect, useState } from "react";
import { authedBlob } from "@/lib/auth";
import { classifyPhotoUrl, initialsOf } from "@/lib/photos";

export default function AuthedImage({
  path,
  alt,
  className,
  headers,
  fallback,
}: {
  /** API-relative path, e.g. "/persons/<id>/photo". */
  path: string;
  alt: string;
  className?: string;
  /** Overrides the Bearer token — a gate terminal passes X-Gate-Key. */
  headers?: Record<string, string>;
  fallback: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(null);
    setFailed(false);

    authedBlob(path, headers)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      // Object URLs leak the whole blob until revoked, and a gate terminal
      // renders hundreds of faces per shift without ever reloading.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // headers is recreated per render by callers; key off its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(headers ?? {})]);

  if (failed || !url) return <>{fallback}</>;

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}

/**
 * Renders a person's photo by whichever strategy their photo_url calls for:
 * credentialed fetch for uploaded photos, a plain img for externally hosted
 * ones (CSV import), initials when there is none.
 */
export function PersonAvatar({
  person,
  className = "h-full w-full object-cover",
  headers,
}: {
  person: { full_name: string; photo_url?: string | null };
  className?: string;
  headers?: Record<string, string>;
}) {
  const { kind, src } = classifyPhotoUrl(person.photo_url);
  const initials = (
    <span className="font-display text-lg font-700 text-ink-soft">
      {initialsOf(person.full_name)}
    </span>
  );

  if (kind === "none") return initials;
  if (kind === "external") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={person.full_name} className={className} />;
  }
  return (
    <AuthedImage
      path={src}
      alt={person.full_name}
      className={className}
      headers={headers}
      fallback={initials}
    />
  );
}
