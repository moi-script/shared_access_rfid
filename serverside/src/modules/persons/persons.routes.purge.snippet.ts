// Test-data purge, not the production delete path above it. Superadmin-only
// like delete/restore, and additionally refused outside a non-production
// environment inside personService.purgeForTesting — that second check is
// the one doing the real work, since this route guard alone would still let
// a superadmin reach it in prod.
personRoutes.delete('/:id/purge', authorize(ROLES.SUPERADMIN), personController.purgeForTesting);
