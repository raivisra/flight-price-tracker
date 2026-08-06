const { pool } = require('../db/connection');

/**
 * price_quotes + query_cache access.
 *
 * Both tables are deliberately user-agnostic. Nothing in here takes a user_id
 * or a search_id — that is what lets N users share one provider call.
 */
class QuoteModel {
  /**
   * Has this exact query already been run today (by anyone)?
   * Returns the cache row, or undefined. A row with result_count = 0 is a
   * legitimate hit: it means "we looked, there was nothing".
   */
  static async findFreshCache(cacheKey, client = pool) {
    const { rows } = await client.query(
      `SELECT id, provider, result_count, truncated, fetched_at
         FROM query_cache
        WHERE cache_key = $1 AND fetched_on = CURRENT_DATE`,
      [cacheKey]
    );
    return rows[0];
  }

  /**
   * Record that a query was executed. Idempotent per (cache_key, day):
   * a second scan on the same day updates the existing row.
   */
  static async recordCache(entry, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO query_cache
         (cache_key, provider, origin, destination, depart_from, depart_to,
          return_from, return_to, trip_length_min, trip_length_max,
          adults, result_count, truncated, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (cache_key, fetched_on) DO UPDATE
         SET result_count = EXCLUDED.result_count,
             truncated    = EXCLUDED.truncated,
             duration_ms  = EXCLUDED.duration_ms,
             fetched_at   = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        entry.cacheKey,
        entry.provider,
        entry.origin,
        entry.destination,
        entry.departFrom,
        entry.departTo,
        entry.returnFrom,
        entry.returnTo,
        entry.tripLengthMin,
        entry.tripLengthMax,
        entry.adults,
        entry.resultCount,
        entry.truncated ?? false,
        entry.durationMs
      ]
    );
    return rows[0].id;
  }

  /**
   * Replace this scan's quotes wholesale: delete the rows belonging to the
   * cache entry, then insert the fresh set.
   *
   * Replace rather than upsert because one date pair legitimately yields many
   * distinct itineraries and Google-sourced rows carry no IATA code, so there
   * is no honest natural key to conflict on. Deleting by query_cache_id keeps a
   * rescan idempotent without pretending alternatives are duplicates.
   *
   * Caller must pass a transaction client so the delete and insert are atomic.
   */
  static async insertQuotes(quotes, queryCacheId, client = pool) {
    await client.query('DELETE FROM price_quotes WHERE query_cache_id = $1', [
      queryCacheId
    ]);
    if (!quotes.length) return 0;

    const cols = 16;
    const values = [];
    const placeholders = quotes.map((q, i) => {
      const b = i * cols;
      values.push(
        queryCacheId,
        q.origin,
        q.destination,
        q.departureDate,
        q.returnDate,
        tripLength(q.departureDate, q.returnDate),
        q.priceTotal,
        q.pricePerPax,
        q.currency,
        q.adults,
        q.airlineCode,
        q.airlineName,
        q.stops,
        q.durationMinutes,
        q.deeplink,
        q.provider
      );
      return `(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(',')})`;
    });

    const { rowCount } = await client.query(
      `INSERT INTO price_quotes
         (query_cache_id, origin, destination, departure_date, return_date,
          trip_length_days, price_total, price_per_pax, currency, adults,
          airline_code, airline_name, stops, duration_minutes, deeplink, provider)
       VALUES ${placeholders.join(',')}`,
      values
    );
    return rowCount;
  }

  /**
   * Read today's cached quotes for a query. This is the cache-hit read path.
   */
  static async findByCacheId(queryCacheId, client = pool) {
    const { rows } = await client.query(
      `SELECT origin, destination,
              to_char(departure_date, 'YYYY-MM-DD') AS "departureDate",
              to_char(return_date,    'YYYY-MM-DD') AS "returnDate",
              price_per_pax::float AS "pricePerPax",
              price_total::float   AS "priceTotal",
              currency, adults,
              airline_code AS "airlineCode", airline_name AS "airlineName",
              stops, duration_minutes AS "durationMinutes",
              deeplink, provider
         FROM price_quotes
        WHERE query_cache_id = $1
        ORDER BY price_per_pax ASC`,
      [queryCacheId]
    );
    return rows;
  }

  /**
   * Price history for a route — powers charts and the LLM insight prompts.
   * Cheapest observed per day.
   */
  static async priceHistory({ origin, destination, days = 90 }, client = pool) {
    const { rows } = await client.query(
      `SELECT to_char(fetched_on, 'YYYY-MM-DD') AS date,
              MIN(price_per_pax)::float         AS "minPricePerPax",
              COUNT(*)::int                     AS observations
         FROM price_quotes
        WHERE origin = $1 AND destination = $2
          AND fetched_on >= CURRENT_DATE - $3::int
        GROUP BY fetched_on
        ORDER BY fetched_on ASC`,
      [origin, destination, days]
    );
    return rows;
  }

  /** Routes worth a proactive background scan: those users actually track. */
  static async trackedRoutes(client = pool) {
    const { rows } = await client.query(
      `SELECT DISTINCT origin, destination,
              MIN(trip_length_min) AS "tripLengthMin",
              MAX(trip_length_max) AS "tripLengthMax",
              COUNT(*)::int        AS "watcherCount"
         FROM searches
        WHERE is_active = true AND status = 'active'
        GROUP BY origin, destination
        ORDER BY "watcherCount" DESC`
    );
    return rows;
  }
}

function tripLength(depart, ret) {
  if (!depart || !ret) return null;
  const ms = new Date(ret) - new Date(depart);
  return Math.round(ms / 86400000);
}

module.exports = QuoteModel;
