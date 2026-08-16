import { Types } from 'mongoose';
import { personPhotoRepo } from './personPhotos.repository';
import { PersonModel } from './persons.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Role, STAFF_SIDE, personDomain } from '../../constants/roles';
import { Actor, assertCanWrite } from '../../utils/authority';

const INTERNAL_PHOTO_URL = (id: string) => `/persons/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Person not found');
}

export const personPhotoService = {
  async upload(personId: string, actor: Actor, file: Express.Multer.File | undefined) {
    assertValidId(personId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    assertCanWrite(actor, personDomain(person.type));

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await personPhotoRepo.upsert(personId, file.buffer, mime);
    person.photo_url = INTERNAL_PHOTO_URL(personId);
    await person.save();

    return { photo_url: person.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  /**
   * `actor` is null for a gate terminal, which has no user session and must be
   * able to show a guard any cardholder's face.
   */
  async get(personId: string, actor: { role: Role; personId: string | null } | null) {
    assertValidId(personId);

    if (actor) {
      const privileged = STAFF_SIDE.includes(actor.role);
      // 404 rather than 403: a 403 confirms the photo exists, which lets an
      // unauthorized caller enumerate which person ids have photos.
      if (!privileged && actor.personId !== personId) {
        throw new ApiError('NOT_FOUND', 'No photo on file');
      }
    }

    const photo = await personPhotoRepo.findByPersonId(personId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(personId: string, actor: Actor) {
    assertValidId(personId);
    const person = await PersonModel.findById(personId);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    assertCanWrite(actor, personDomain(person.type));

    await personPhotoRepo.deleteByPersonId(personId);

    // Only clear photo_url when it points at us. An externally hosted URL
    // (bulk CSV import) is not ours to erase.
    if (person.photo_url === INTERNAL_PHOTO_URL(personId)) {
      person.photo_url = undefined;
      await person.save();
    }
    return { photo_url: person.photo_url ?? null };
  },
};
