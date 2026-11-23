/*
 * The workshop's three desks, kept apart.
 *
 * `Stages.gs` has ST_CUT, ST_PROD and ST_Q — cutting, production and quality
 * — and they are three different people doing three different jobs. The
 * portal ran all six stage actions off `warehouse.rolls.report`, so whoever
 * cut the fabric could also record what production made and sign off what
 * quality counted.
 *
 * That is the whole of the control gone. The numbers at the end of a job
 * order are worth something only because three desks produced them
 * separately: cutting says how many metres went in, production says how many
 * pieces came out, quality says how many of those it actually counted. One
 * person holding all three can make those agree without anybody noticing.
 *
 * `warehouse.rolls.report` stays and keeps its meaning — reporting a
 * finished job order back to the warehouse — rather than being quietly
 * repurposed.
 */

INSERT INTO core_permissions (key, module_key, description) VALUES
  ('warehouse.stage.cut',        'warehouse', 'Start and finish cutting, and release lots to production'),
  ('warehouse.stage.production', 'warehouse', 'Record the quantity production sends to workshop quality'),
  ('warehouse.stage.quality',    'warehouse', 'Count a lot at workshop quality and hand it to the warehouse')
ON CONFLICT (key) DO UPDATE
  SET module_key = EXCLUDED.module_key, description = EXCLUDED.description;

-- Admin only, as with the rest of the module. Who cuts and who counts is a
-- decision for Worood, made on the Roles screen, not one a migration should
-- make on their behalf.
INSERT INTO core_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core_roles r
  CROSS JOIN core_permissions p
 WHERE r.key = 'admin'
   AND p.key IN ('warehouse.stage.cut',
                 'warehouse.stage.production',
                 'warehouse.stage.quality')
ON CONFLICT DO NOTHING;