CREATE FUNCTION stat_source_rank(category_code text, source_id text)
RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN category_code IN ('hsr', 'ld') THEN
      CASE
        WHEN source_id = 'db-iris' THEN 0
        WHEN source_id = 'gtfsde-rt' THEN 1
        WHEN source_id IN ('mobilithek-delfi-gtfs-rt', 'delfi-gtfs-rt', 'delfi-gtfs-rt-deincr') THEN 2
        WHEN source_id IN ('vbb-gtfs-rt', 'vbn-gtfs-rt') THEN 3
        ELSE 4
      END
    ELSE
      CASE
        WHEN source_id IN ('mobilithek-delfi-gtfs-rt', 'delfi-gtfs-rt', 'delfi-gtfs-rt-deincr') THEN 0
        WHEN source_id = 'gtfsde-rt' THEN 1
        WHEN source_id IN ('vbb-gtfs-rt', 'vbn-gtfs-rt') THEN 2
        WHEN source_id = 'db-iris' THEN 4
        ELSE 3
      END
  END::smallint
$$;

CREATE FUNCTION stat_source_member_order(source_id text)
RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE source_id
    WHEN 'delfi-gtfs-rt' THEN 1
    WHEN 'delfi-gtfs-rt-deincr' THEN 2
    ELSE 0
  END::smallint
$$;

CREATE FUNCTION stat_source_key(category_code text, source_id text, final_quality text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN final_quality = 'carried' THEN '1' ELSE '0' END
    || public.stat_source_rank(category_code, source_id)::text
    || public.stat_source_member_order(source_id)::text
    || ':' || source_id
$$;

CREATE TABLE stat_bin (
  kind text NOT NULL,
  bin smallint NOT NULL,
  lower_value integer,
  upper_value integer,
  unit text NOT NULL,
  CONSTRAINT stat_bin_pkey PRIMARY KEY (kind, bin),
  CONSTRAINT stat_bin_kind_known CHECK (kind IN ('delay', 'gain', 'speed')),
  CONSTRAINT stat_bin_unit_rule CHECK (unit = CASE kind WHEN 'speed' THEN 'km/h' ELSE 's' END),
  CONSTRAINT stat_bin_bounds CHECK (lower_value IS NOT NULL OR upper_value IS NOT NULL),
  CONSTRAINT stat_bin_order CHECK (lower_value < upper_value)
);

INSERT INTO stat_bin (kind, bin, lower_value, upper_value, unit)
SELECT 'delay', b, lo, hi, 's' FROM (VALUES
  (0, -1800, -300), (1, -300, 0),
  (2, 0, 60), (3, 60, 120), (4, 120, 180), (5, 180, 240), (6, 240, 300), (7, 300, 360),
  (8, 360, 420), (9, 420, 480), (10, 480, 540), (11, 540, 600), (12, 600, 660), (13, 660, 720),
  (14, 720, 780), (15, 780, 840), (16, 840, 900), (17, 900, 960),
  (18, 960, 1200), (19, 1200, 1500), (20, 1500, 1800), (21, 1800, 2100), (22, 2100, 2400),
  (23, 2400, 2700), (24, 2700, 3000), (25, 3000, 3300), (26, 3300, 3600),
  (27, 3600, 5400), (28, 5400, 7200), (29, 7200, NULL)
) AS v (b, lo, hi)
UNION ALL
SELECT 'gain', b, lo, hi, 's' FROM (VALUES
  (0, NULL, -600), (1, -600, -300),
  (2, -300, -240), (3, -240, -180), (4, -180, -120), (5, -120, -60), (6, -60, 0), (7, 0, 60),
  (8, 60, 120), (9, 120, 180), (10, 180, 240), (11, 240, 300), (12, 300, 360), (13, 360, 420),
  (14, 420, 480), (15, 480, 540), (16, 540, 600),
  (17, 600, 900), (18, 900, 1800), (19, 1800, 3600), (20, 3600, NULL)
) AS v (b, lo, hi)
UNION ALL
SELECT 'speed', b, b * 10, CASE WHEN b < 30 THEN (b + 1) * 10 END, 'km/h' FROM generate_series(0, 30) AS b;

CREATE FUNCTION stat_delay_bin(delay_s integer)
RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN delay_s IS NULL OR delay_s < -1800 THEN NULL
    WHEN delay_s < -300 THEN 0
    WHEN delay_s < 0 THEN 1
    WHEN delay_s < 960 THEN 2 + delay_s / 60
    WHEN delay_s < 1200 THEN 18
    WHEN delay_s < 3600 THEN 19 + (delay_s - 1200) / 300
    WHEN delay_s < 5400 THEN 27
    WHEN delay_s < 7200 THEN 28
    ELSE 29
  END::smallint
$$;

CREATE FUNCTION stat_gain_bin(gain_s integer)
RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN gain_s IS NULL THEN NULL
    WHEN gain_s < -600 THEN 0
    WHEN gain_s < -300 THEN 1
    WHEN gain_s < 600 THEN 2 + (gain_s + 300) / 60
    WHEN gain_s < 900 THEN 17
    WHEN gain_s < 1800 THEN 18
    WHEN gain_s < 3600 THEN 19
    ELSE 20
  END::smallint
$$;

CREATE FUNCTION stat_speed_bin(speed_kmh double precision)
RETURNS smallint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN speed_kmh IS NULL OR speed_kmh < 0 OR speed_kmh = 'NaN'::double precision THEN NULL
    WHEN speed_kmh >= 300 THEN 30
    ELSE floor(speed_kmh / 10)
  END::smallint
$$;

CREATE FUNCTION stat_hist_add(a bigint[], b bigint[])
RETURNS bigint[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $$
BEGIN
  IF a IS NULL THEN
    RETURN b;
  END IF;
  IF b IS NULL THEN
    RETURN a;
  END IF;
  IF cardinality(a) <> cardinality(b) THEN
    RAISE EXCEPTION 'histograms of different lengths (% and %) cannot be added', cardinality(a), cardinality(b)
      USING ERRCODE = 'data_exception';
  END IF;
  RETURN ARRAY(SELECT x + y FROM unnest(a, b) WITH ORDINALITY AS u (x, y, i) ORDER BY i);
END
$$;

CREATE AGGREGATE stat_hist_sum(bigint[]) (
  SFUNC = stat_hist_add,
  STYPE = bigint[],
  COMBINEFUNC = stat_hist_add,
  PARALLEL = SAFE
);

CREATE FUNCTION stat_hist_counts(hist bigint[])
RETURNS bigint[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hist[2:cardinality(hist) - 1]
$$;

CREATE FUNCTION stat_hist_quantile(hist bigint[], kind text, q double precision)
RETURNS double precision
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  WITH counts AS (
    SELECT b.bin, b.lower_value, b.upper_value, coalesce(c.n, 0) AS n
      FROM public.stat_bin b
      LEFT JOIN unnest(public.stat_hist_counts(hist)) WITH ORDINALITY AS c (n, i) ON c.i = b.bin + 1
     WHERE b.kind = stat_hist_quantile.kind
  ),
  cumulative AS (
    SELECT *, sum(n) OVER (ORDER BY bin) AS upto, sum(n) OVER () AS total FROM counts
  ),
  target AS (
    SELECT * FROM cumulative
     WHERE total > 0 AND q BETWEEN 0 AND 1 AND upto >= q * total AND n > 0
     ORDER BY bin LIMIT 1
  )
  SELECT CASE
    WHEN lower_value IS NULL THEN upper_value::double precision
    WHEN upper_value IS NULL THEN lower_value::double precision
    ELSE lower_value + (upper_value - lower_value) * (q * total - (upto - n)) / n
  END
  FROM target
$$;
