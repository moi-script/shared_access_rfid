import { Types } from 'mongoose';
import { gadgetPhotoRepo } from './gadgetPhotos.repository';
import { GadgetModel } from './gadgets.model';
import { detectImageType } from '../../utils/imageType';
import { ApiError } from '../../utils/ApiError';
import { Actor, assertCanWrite } from '../../utils/authority';

const INTERNAL_PHOTO_URL = (id: string) => `/gadgets/${id}/photo`;

function assertValidId(id: string): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Gadget not found');
}

export const gadgetPhotoService = {
  async upload(gadgetId: string, actor: Actor, file: Express.Multer.File | undefined) {
    assertValidId(gadgetId);
    if (!file) throw new ApiError('VALIDATION_ERROR', 'No photo uploaded (field name: photo)');

    assertCanWrite(actor, 'gadget');
    const gadget = await GadgetModel.findById(gadgetId);
    if (!gadget) throw new ApiError('NOT_FOUND', 'Gadget not found');

    // The declared Content-Type is ignored; only the bytes decide.
    const mime = detectImageType(file.buffer);
    if (!mime) {
      throw new ApiError('VALIDATION_ERROR', 'File is not a JPEG, PNG, or WebP image');
    }

    const saved = await gadgetPhotoRepo.upsert(gadgetId, file.buffer, mime);
    gadget.photo_url = INTERNAL_PHOTO_URL(gadgetId);
    await gadget.save();

    return { photo_url: gadget.photo_url, mime: saved.mime, byte_size: saved.byte_size };
  },

  /**
   * No actor argument, matching vehiclePhotoService.get and for the same
   * reason: a person photo needs an ownership check because a student may fetch
   * their own face and nobody else's, whereas a gadget has no such
   * self-service surface. Any caller the route already authenticated may read
   * it. The route is what restricts this, not the service.
   *
   * Note that the route uses authenticateAny, which accepts a gate device key
   * OR any user JWT — so this is readable by every authenticated session, not
   * just OSS. That is a property of the middleware shared with the person and
   * vehicle photo routes, not something introduced here; tightening it means
   * changing all three at once.
   */
  async get(gadgetId: string) {
    assertValidId(gadgetId);
    const photo = await gadgetPhotoRepo.findByGadgetId(gadgetId);
    if (!photo) throw new ApiError('NOT_FOUND', 'No photo on file');
    return photo;
  },

  async remove(gadgetId: string, actor: Actor) {
    assertValidId(gadgetId);
    assertCanWrite(actor, 'gadget');
    const gadget = await GadgetModel.findById(gadgetId);
    if (!gadget) throw new ApiError('NOT_FOUND', 'Gadget not found');

    await gadgetPhotoRepo.deleteByGadgetId(gadgetId);

    // Only clear photo_url when it points at us. An externally hosted URL is
    // not ours to erase.
    if (gadget.photo_url === INTERNAL_PHOTO_URL(gadgetId)) {
      gadget.photo_url = undefined;
      await gadget.save();
    }
    return { photo_url: gadget.photo_url ?? null };
  },
};
