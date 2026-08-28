import { ApiError } from '../../utils/ApiError';

/**
 * May this person have a vehicle or gadget registered to them right now?
 *
 * Every issue point (vehicles.service, gadgets.service,
 * vehicleApplications.service) already refuses an owner who is missing or
 * soft-deleted. None of them looked at `status`, so a person who had been
 * deactivated in the directory — their card already refused at the barrier by
 * scan.service — could still be handed a freshly registered vehicle or
 * gadget, and that vehicle's OWN card would be granted. Deactivation has to
 * close the registration desk as well as the gate, or it only half-closes.
 *
 * The test is `!== 'active'`, not `=== 'inactive'`, and it is the same test
 * scan.service.tap applies to the person before granting. 'pending' is
 * therefore refused too: a record that has not been activated yet has no more
 * claim on a parking slot than one that has been switched off. Keeping the
 * two call sites on one predicate is the point — a person the gate will not
 * admit must not be accumulating registrations behind it.
 *
 * Deliberately its own module rather than a method on personService:
 * vehicles.service and gadgets.service already import personRepo, and
 * persons.service imports vehicleRepo/VehicleModel back. Hanging this off
 * personService would close that loop into an import cycle. This file imports
 * nothing but ApiError and takes an already-fetched person, so it cannot.
 */
export function assertOwnerRegistrable(
  owner: { full_name: string; status: string },
  noun: 'vehicle' | 'gadget'
): void {
  if (owner.status !== 'active') {
    throw new ApiError(
      'CONFLICT',
      `${owner.full_name}'s record is ${owner.status}, so no ${noun} can be registered to them. ` +
        'Reactivate them in the directory first.'
    );
  }
}
