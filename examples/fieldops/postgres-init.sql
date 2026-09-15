-- Runs once, on the container's first start.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Something for the collector to see: a table with rows and an index.
CREATE TABLE IF NOT EXISTS work_orders (
  id          text PRIMARY KEY,
  status      text NOT NULL,
  priority    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_orders_status_idx ON work_orders (status);

INSERT INTO work_orders (id, status, priority)
SELECT 'wo_' || g, (ARRAY['scheduled', 'in_progress', 'completed'])[1 + g % 3], (ARRAY['low', 'normal', 'high', 'urgent'])[1 + g % 4]
FROM generate_series(1, 5000) AS g
ON CONFLICT DO NOTHING;
