const { pool } = require('../db/connection');

const RETURNING = `
  id, user_id AS "userId", label, origin, destination,
  to_char(start_date, 'YYYY-MM-DD') AS "startDate",
  to_char(end_date,   'YYYY-MM-DD') AS "endDate",
  trip_length_min AS "tripLengthMin", trip_length_max AS "tripLengthMax",
  adults, currency,
  max_stops AS "maxStops", max_duration_minutes AS "maxDurationMinutes",
  alert_price_pp::float AS "alertPricePp",
  scan_frequency AS "scanFrequency", last_scanned_at AS "lastScannedAt",
  status, created_at AS "createdAt"
`;

/** A user's tracked route configuration. */
class SearchModel {
  static async create(userId, s, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO searches
         (user_id, label, origin, destination, start_date, end_date,
          trip_length_min, trip_length_max, adults, currency,
          max_stops, max_duration_minutes, alert_price_pp, scan_frequency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${RETURNING}`,
      [
        userId, s.label, s.origin, s.destination, s.startDate, s.endDate,
        s.tripLengthMin, s.tripLengthMax, s.adults, s.currency,
        s.maxStops, s.maxDurationMinutes, s.alertPricePp, s.scanFrequency
      ]
    );
    return rows[0];
  }

  static async listByUser(userId, client = pool) {
    const { rows } = await client.query(
      `SELECT ${RETURNING} FROM searches
        WHERE user_id = $1 AND is_active = true
        ORDER BY created_at DESC`,
      [userId]
    );
    return rows;
  }

  /** Scoped by user_id so one user can never read another's search by id. */
  static async findById(id, userId, client = pool) {
    const { rows } = await client.query(
      `SELECT ${RETURNING} FROM searches
        WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [id, userId]
    );
    return rows[0];
  }

  /**
   * Partial update. Only whitelisted columns are settable, so a caller cannot
   * smuggle in user_id or is_active via the request body.
   */
  static async update(id, userId, patch, client = pool) {
    const allowed = {
      label: 'label',
      startDate: 'start_date',
      endDate: 'end_date',
      tripLengthMin: 'trip_length_min',
      tripLengthMax: 'trip_length_max',
      adults: 'adults',
      currency: 'currency',
      maxStops: 'max_stops',
      maxDurationMinutes: 'max_duration_minutes',
      alertPricePp: 'alert_price_pp',
      scanFrequency: 'scan_frequency',
      status: 'status'
    };

    const sets = [];
    const values = [];
    for (const [key, col] of Object.entries(allowed)) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (!sets.length) return this.findById(id, userId, client);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, userId);

    const { rows } = await client.query(
      `UPDATE searches SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND user_id = $${values.length}
          AND is_active = true
        RETURNING ${RETURNING}`,
      values
    );
    return rows[0];
  }

  /** Soft delete — keeps price history and alert log meaningful. */
  static async remove(id, userId, client = pool) {
    const { rowCount } = await client.query(
      `UPDATE searches
          SET is_active = false, deleted_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [id, userId]
    );
    return rowCount > 0;
  }

  /**
   * Searches the background scanner should visit now.
   *
   * Note this returns one row PER SEARCH, not per route: two users tracking the
   * same route both come back. That is intentional — each needs its own alert
   * evaluation. The provider call is still made once, because the scan goes
   * through the shared daily cache.
   */
  static async dueForScan(client = pool) {
    const { rows } = await client.query(
      `SELECT ${RETURNING} FROM searches
        WHERE is_active = true AND status = 'active'
          AND (
            last_scanned_at IS NULL
            OR (scan_frequency = 'daily'  AND last_scanned_at < CURRENT_DATE)
            OR (scan_frequency = 'weekly' AND last_scanned_at < CURRENT_DATE - 7)
          )
          -- Skip windows that have already passed.
          AND end_date >= CURRENT_DATE
        ORDER BY last_scanned_at ASC NULLS FIRST`
    );
    return rows;
  }

  static async markScanned(id, client = pool) {
    await client.query(
      'UPDATE searches SET last_scanned_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );
  }
}

module.exports = SearchModel;
