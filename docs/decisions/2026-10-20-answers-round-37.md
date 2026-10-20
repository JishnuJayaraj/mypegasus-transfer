# Answers — round 37 (2026-10-20)

Source: the product-owner post-merge review of [PR #63](https://github.com/JishnuJayaraj/mypegasus-transfer/pull/63#issuecomment-6298957127).

## Q131 — Readings of the Slice 3 org model

Accepted with two corrections:

- **(a)** A global admin cannot deactivate their own account or remove their own admin role.
  Every operation that can remove active admin authority serialises on one stable transaction lock
  and re-checks the actor under that lock, so concurrent mutual operations preserve an active
  admin.
- **(b)** Regional org roles may read the global template catalog. It is non-personal reference
  data. Project visibility remains region-scoped; members also see their projects, including a
  legacy project without a region.
- **(c)** Deactivation removes all org-role grants in the same transaction as sessions,
  memberships and assignments. The audit history preserves each removed role, its region and the
  `account_deactivated` reason. Revoked org-role and removed membership rows are deleted; assignment
  rows are closed and retained.
- **(d)** Every new project requires a region (`region_required`). Legacy projects may remain
  unassigned and are visible only to members and global roles until corrected.
- **(e)** A PL may assign a participation in any lifecycle status, including a terminal status,
  for close-out work. This gives only the normal retained-data access for that phase and cannot
  bypass the later evidence-set/break-glass boundary.
- **(f)** Member search returns active staff only, searches by name, returns at most 20 results,
  and includes only id and display name. It is available to a PL or global admin.

No external Legal/DPO confirmation is required for synthetic-data development. Executable
retention periods remain `unset`.
