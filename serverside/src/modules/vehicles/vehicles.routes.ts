import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateAny } from '../../middlewares/authenticateAny';
import { uploadPhoto } from '../../middlewares/uploadImage';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleController } from './vehicles.controller';
import { createVehicleSchema, updateVehicleSchema, vehicleStatusSchema } from './vehicles.schema';

export const vehicleRoutes = Router();

// Declared BEFORE the router-level authenticate/authorize on purpose. A gate
// terminal has no user session — it authenticates with X-Gate-Key, which
// `authenticate` rejects. Put this route below the .use() and every terminal
// fetch 401s, the AuthedImage falls back to its placeholder, and the failure
// looks like "the photo didn't upload" rather than "the route is unreachable".
// persons.routes.ts:24 uses the identical pattern for face photos.
vehicleRoutes.get('/:id/photo', authenticateAny, vehicleController.getPhoto);

// Reads are shared across the staff-side console; writes are OSS-only, enforced
// in the service by assertCanWrite('vehicle'). This deliberately reverses
// "Vehicles stay superadmin-only" from the role-system spec: vehicle
// registration is the OSS office's whole purpose.
vehicleRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);
vehicleRoutes.get('/', vehicleController.list);
vehicleRoutes.get('/:id', vehicleController.get);
vehicleRoutes.post('/', validate(createVehicleSchema), vehicleController.create);
vehicleRoutes.patch('/:id', validate(updateVehicleSchema), vehicleController.update);
vehicleRoutes.patch('/:id/status', validate(vehicleStatusSchema), vehicleController.setStatus);
vehicleRoutes.post('/:id/photo', uploadPhoto, vehicleController.uploadPhoto);
vehicleRoutes.delete('/:id/photo', vehicleController.deletePhoto);
