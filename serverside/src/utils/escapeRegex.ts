/**
 * Escapes every regex metacharacter so a user-supplied string matches
 * literally inside a Mongo `$regex`.
 *
 * Plate numbers are the reason this exists: `CAV (8832` reaches the driver as
 * an unterminated group and throws, where a name rarely would. personService's
 * search (persons.service.ts) still interpolates raw input and has the same
 * latent bug — fixing it there touches the directory, the deleted-persons view
 * and CSV export at once, so it is deliberately left for its own change.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
