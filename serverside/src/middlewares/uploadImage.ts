import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../utils/ApiError';

export const MAX_PHOTO_BYTES = 1_048_576;
// A trimmed, transparent-background signature PNG runs a few KB. 256 KB is
// generous for that and still refuses a photo pasted into the wrong field.
export const MAX_SIGNATURE_BYTES = 262_144;

/**
 * Builds a single-file memory upload for one form field.
 *
 * Multer reports its own errors rather than throwing ApiError, so they are
 * translated here. A size overrun is 413, not a generic validation failure.
 */
function uploadImage(field: string, maxBytes: number) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single(field);

  return function handle(req: Request, res: Response, next: NextFunction): void {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new ApiError('PAYLOAD_TOO_LARGE'));
          return;
        }
        next(new ApiError('VALIDATION_ERROR', err.message));
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  };
}

export const uploadPhoto = uploadImage('photo', MAX_PHOTO_BYTES);
export const uploadSignature = uploadImage('signature', MAX_SIGNATURE_BYTES);
export const uploadApplicationSignature = uploadImage('signature', MAX_SIGNATURE_BYTES);
