import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleApplicationController } from './vehicleApplications.controller';
import { createApplicationSchema } from './vehicleApplications.schema';
import { uploadApplicationSignature } from '../../middlewares/uploadImage';

export const vehicleApplicationRoutes = Router();

// Reads are shared across the staff-side console, consistent with RBAC v2's
// "scoped writes, shared reads". Writes are OSS-only, enforced in the service
// by assertCanWrite(actor, 'vehicle'). This also covers the signature
// sub-routes below: unlike a person's signature (a self-service field a
// portal user contributes), an application signature belongs to an office
// process, not a login, so there is no reason to declare it ahead of this
// guard. And unlike a face photo, a barrier has no use for a signature, so
// there is no device-key path here either — same reasoning already recorded
// on the person-signature route.
vehicleApplicationRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);

vehicleApplicationRoutes.get('/', vehicleApplicationController.list);
vehicleApplicationRoutes.get('/:id', vehicleApplicationController.get);
vehicleApplicationRoutes.post('/', validate(createApplicationSchema), vehicleApplicationController.create);

// GET is shared read (all four staff-side roles); POST is OSS-only via
// assertCanWrite(actor, 'vehicle') in the service. No PATCH/PUT and no
// DELETE: the document is frozen once written, same immutability rule as the
// application itself — a replacement signature would defeat the point of
// freezing it, hence CONFLICT on a second POST rather than a route to redo it.
vehicleApplicationRoutes.get('/:id/signature', vehicleApplicationController.getSignature);
vehicleApplicationRoutes.post(
  '/:id/signature',
  uploadApplicationSignature,
  vehicleApplicationController.uploadSignature
);

// Deliberately NO patch and NO delete. An application is the record of what was
// submitted and signed; a correction is a new application, and the older one
// stays. Immutability enforced by the absence of a route cannot be bypassed by
// a future caller, whereas immutability by convention is only a comment.
