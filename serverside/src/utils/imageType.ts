export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/**
 * Identifies an image by its leading bytes. A client-declared Content-Type is
 * not evidence of content, so uploads are classified from the bytes alone and
 * the result is what gets stored and later served.
 *
 * Returns null for anything not on the whitelist.
 */
export function detectImageType(buf: Buffer): ImageMime | null {
  // JPEG: FF D8 FF, then a marker byte — 3 bytes alone is a truncated file.
  if (buf.length >= 4 && startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, PNG_SIGNATURE)) return 'image/png';
  // WebP: "RIFF" then 4 size bytes then "WEBP".
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
                 