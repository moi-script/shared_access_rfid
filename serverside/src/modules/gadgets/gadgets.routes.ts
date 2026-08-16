import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateAny } from '../../middlewares/authenticateAny';
import { uploadPhoto } from '../../middlewares/uploadImage';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { gadgetController } from './gadgets.controller';
import { createGadgetSchema, updateGadgetSchema, gadgetStatusSchema } from './gadgets.schema';

export const gadgetRoutes = Router();

// Declared BEFORE the router-level authenticate/authorize on purpose. A gate
// terminal has no user session — it authenticates with X-Gate-Key, which
// `authenticate` rejects. Put this route below the .use() and every terminal
// fetch 401s, the AuthedImage falls back to its placeholder, and the failure
// looks like "the photo didn't upload" rather than "the route is unreachable".
// vehicles.routes.ts:19 and persons.routes.ts:24 use the identical pattern.
gadgetRoutes.get('/:id/photo', authenticateAny, gadgetController.getPhoto);

// Reads are shared across the staff-side console; writes are OSS-only, enforced
// in the service by assertCanWrite('gadget'). Same split as vehicles, and for
// the same reason: OSS cannot attach an owner to a laptop without reading a
// person that the registrar created, and the courtesy runs both ways.
gadgetRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);
gadgetRoutes.get('/', gadgetController.list);
gadgetRoutes.get('/:id', gadgetController.get);
gadgetRoutes.post('/', validate(createGadgetSchema), gadgetController.create);
gadgetRoutes.patch('/:id', validate(updateGadgetSchema), gadgetController.update);
gadgetRoutes.patch('/:id/status', validate(gadgetStatusSchema), gadgetController.setStatus);
gadgetRoutes.post('/:id/photo', uploadPhoto, gadgetController.uploadPhoto);
gadgetRoutes.delete('/:id/photo', gadgetController.deletePhoto);
