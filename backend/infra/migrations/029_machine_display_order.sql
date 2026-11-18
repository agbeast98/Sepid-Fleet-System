BEGIN;
SELECT pg_advisory_xact_lock(514029);

ALTER TABLE machines ADD COLUMN IF NOT EXISTS sort_order integer;

UPDATE machines SET sort_order = CASE id
  WHEN 'm1' THEN 10
  WHEN 'm2' THEN 20
  WHEN 'm3' THEN 30
  WHEN 'm4' THEN 40
  WHEN 'm5' THEN 50
  WHEN 'm6' THEN 60
  WHEN 'm7' THEN 70
  WHEN 'm8' THEN 80
  WHEN 'm9' THEN 90
  WHEN 'm10' THEN 100
  WHEN 'm11' THEN 110
  ELSE sort_order
END
WHERE sort_order IS NULL OR id IN ('m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11');

WITH additional AS (
  SELECT id, 1000 + row_number() OVER (ORDER BY code, id) * 10 AS position
  FROM machines WHERE sort_order IS NULL
)
UPDATE machines m SET sort_order = additional.position
FROM additional WHERE additional.id = m.id;

ALTER TABLE machines ALTER COLUMN sort_order SET NOT NULL;
CREATE SEQUENCE IF NOT EXISTS machine_sort_order_seq;
SELECT setval('machine_sort_order_seq', COALESCE((SELECT max(sort_order) FROM machines), 0) + 10, false);
ALTER TABLE machines ALTER COLUMN sort_order SET DEFAULT nextval('machine_sort_order_seq');

COMMIT;
