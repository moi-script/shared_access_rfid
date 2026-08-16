import { z } from 'zod';
import { GADGET_TYPES } from '../../constants/gadgetTypes';

export const createGadgetSchema = z.object({
  owner_person_id: z.string().min(1),
  // zod's enum needs a mutable [string, ...string[]] tuple, so the readonly
  // const array is spread and re-asserted. This is the whole cost of having one
  // list instead of two.
  gadget_type: z.enum([...GADGET_TYPES] as [string, ...string[]]),
  brand_model: z.string().min(1),
  // Deliberately NOT normalized here. Casing and surrounding whitespace are
  // fixed in one place, the service, so that the value checked against the
  // unique index and the value written cannot come from different expressions.
  // A .transform() here would put a second normalizer on the update path only
  // for someone to later forget it on a third.
  serial_number: z.string().min(1).max(64),
  photo_url: z.string().url().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/**
 * owner_person_id is deliberately KEPT here, even though a gadget cannot change
 * hands, so that gadgetService.update can reject an attempted transfer out
 * loud.
 *
 * Omitting it instead would be worse than it looks: `validate` replaces
 * req.body with zod's parsed output, and zod strips unknown keys by default, so
 * an omitted field would be silently deleted before the service ever saw it.
 * The caller would get a 200 and believe the transfer happened. Letting it
 * through to a service that throws is the difference between a no-op that
 * reports success and a refusal that explains itself.
 */
export const updateGadgetSchema = createGadgetSchema.partial();

export const gadgetStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
