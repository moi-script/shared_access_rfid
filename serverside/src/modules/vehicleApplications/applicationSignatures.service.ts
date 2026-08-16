import { Types } from 'mongoose';
import { applicationSignatureRepo } from './applicationSignatures.repository';
import { vehicleApplicationRepo } from './vehicleApplications.repository';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Actor, assertCanWrite } from '../../utils/authority';

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Application not found');
}

/**
 * Mirrors personSignatureService but simpler: there is no self-service case.
 * An application belongs to an office process (OSS submits it), not to the
 * applicant's own login, so the only actor check is the same write-domain
 * gate that governs the rest of the module.
 */
export const applicationSignatureService = {
  async upload(
    applicationId: string,
    actor: Actor,
    file: Express.Multer.File | undefined
  ) {
    assertValidId(applicationId);
    assertCanWrite(actor, 'vehicle');

    const application = await vehicleApplicationRepo.findById(applicationId);
    if (!application) throw new ApiError('NOT_FOUND', 'Application not found');

    if (!file) {
      throw new ApiError('VALIDATION_ERROR', 'No signature uploaded (field name: signature)');
    }

    // The declared Content-Type is ignored; only the bytes decide. PNG alone,
    // for the same reason as personSignatures: only PNG carries the
    // transparent background the capture canvas exports.
    const mime = detectImageType(file.buffer);
    if (mime !== 'image/png') {
      throw new ApiError('VALIDATION_ERROR', 'Signature must be a PNG image');
    }

    // The document is frozen: a second upload is a replacement attempt, not
    // a correction, and must be rejected rather than silently overwriting
    // what a signer actually put their name to.
    const existing = await applicationSignatureRepo.findByApplicationId(applicationId);
    if (existing) {
      throw new ApiError('CONFLICT', 'This application already has a signature on file');
    }

    const saved = await applicationSignatureRepo.create(applicationId, file.buffer);
    return {
      mime: saved.mime,
      byte_size: saved.byte_size,
    };
  },

  async get(applicationId: string) {
    assertValidId(applicationId);

    const signature = await applicationSignatureRepo.findByApplicationId(applicationId);
    if (!signature) throw new ApiError('NOT_FOUND', 'No signature on file');
    return signature;
  },
};
