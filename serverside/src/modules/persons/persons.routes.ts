import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateAny } from '../../middlewares/authenticateAny';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { personController } from './persons.controller';
import { uploadPhoto, uploadSignature } from '../../middlewares/uploadImage';
import {
  createPersonSchema,
  updatePersonSchema,
  statusSchema,
  reassignRfidSchema,
  importPersonsSchema,
} from './persons.schema';

export const personRoutes = Router();

// Declared before the router-level authorize on purpose: any authenticated
// user may fetch a photo (a student's dashboard renders their own), while
// everything below is registrar/superadmin only. A gate terminal has no user
// session but is the main consumer of face photos, so this route also
// accepts a device key.
personRoutes.get('/:id/photo', authenticateAny, personController.getPhoto);

// Also declared before the router-level authorize: a signature is the one
// thing a portal user contributes to their own record, so student and staff
// accounts must be able to write here. Ownership is enforced per-request in
// personSignatures.service — registrars and superadmins pass the same check,
// which is what lets them capture a signature at the desk. No device key:
// unlike a face photo, a gate has no use for a signature.
personRoutes.get('/:id/signature', authenticate, personController.getSignature);
personRoutes.post(
  '/:id/signature',
  authenticate,
  uploadSignature,
  personController.uploadSignature
);
personRoutes.delete('/:id/signature', authenticate, personController.deleteSignature);

// All four staff-side roles may READ. Write authority is enforced per-verb in
// the service by assertCanWrite: OSS gets in here for the vehicle owner picker
// and is denied every person write, because WRITE_DOMAINS.oss has no person:*
// entry. The route guard and the domain guard do different jobs.
personRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);

personRoutes.get('/', personController.list);
personRoutes.get('/sections', personController.sections);
personRoutes.get('/export', personController.export);

// Declared before `/:id` on purpose — Express matches in declaration order,
// and `/:id` would otherwise capture 'deleted' as an id (see the
// `bulk-status` comment in users.routes.ts for the same trap). Superadmin
// only, layered on top of the router-level guard above: the deleted view
// exists solely so a superadmin can find someone to restore, not as a wider
// directory read for registrar/hr/oss.
personRoutes.get('/deleted', authorize(ROLES.SUPERADMIN), personController.listDeleted);

personRoutes.get('/:id/overview', personController.overview);
personRoutes.get('/:id', personController.get);
personRoutes.post('/', validate(createPersonSchema), personController.create);
personRoutes.post('/import', validate(importPersonsSchema), personController.import);
personRoutes.patch('/:id', validate(updatePersonSchema), personController.update);
personRoutes.patch('/:id/rfid', validate(reassignRfidSchema), personController.reassignRfid);
personRoutes.post('/:id/photo', uploadPhoto, personController.uploadPhoto);
personRoutes.delete('/:id/photo', personController.deletePhoto);

// Same four staff-side roles as the router guard above — status is a write,
// so domain scoping (via assertCanWrite in the service) is what actually
// restricts it, not this route guard.
personRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS),
  validate(statusSchema),
  personController.setStatus
);

// Delete and restore are superadmin-only, matching DELETE /users/:id: the
// cascade closes a physical gate (vehicles deactivated, card blocked, login
// killed), which is a bigger blast radius than the domain-scoped writes
// above and is not something registrar/hr/oss authority should reach.
personRoutes.delete('/:id', authorize(ROLES.SUPERADMIN), personController.remove);
personRoutes.post('/:id/restore', authorize(ROLES.SUPERADMIN), personController.restore);
