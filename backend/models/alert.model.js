const { pool } = require('../db/connection');

class AlertModel {
  static async create(searchId, a, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO alerts
         (search_id, triggered_price_pp, threshold_pp, departure_date, return_date,
          airline_name, stops, duration_minutes, deeplink)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, triggered_price_pp::float AS "triggeredPricePp",
                 threshold_pp::float AS "thresholdPp",
                 to_char(departure_date,'YYYY-MM-DD') AS "departureDate",
                 to_char(return_date,'YYYY-MM-DD')    AS "returnDate",
                 status, created_at AS "createdAt"`,
      [
        searchId, a.triggeredPricePp, a.thresholdPp, a.departureDate, a.returnDate,
        a.airlineName, a.stops, a.durationMinutes, a.deeplink
      ]
    );
    return rows[0];
  }

  /** Most recent alert for a search, used to suppress repeat notifications. */
  static async lastForSearch(searchId, client = pool) {
    const { rows } = await client.query(
      `SELECT id, triggered_price_pp::float AS "triggeredPricePp", created_at AS "createdAt"
         FROM alerts
        WHERE search_id = $1 AND status <> 'dismissed'
        ORDER BY created_at DESC
        LIMIT 1`,
      [searchId]
    );
    return rows[0];
  }

  static async listByUser(userId, limit = 50, client = pool) {
    const { rows } = await client.query(
      `SELECT a.id, a.search_id AS "searchId", s.label, s.origin, s.destination,
              a.triggered_price_pp::float AS "triggeredPricePp",
              a.threshold_pp::float       AS "thresholdPp",
              to_char(a.departure_date,'YYYY-MM-DD') AS "departureDate",
              to_char(a.return_date,'YYYY-MM-DD')    AS "returnDate",
              a.airline_name AS "airlineName", a.stops,
              a.duration_minutes AS "durationMinutes",
              a.deeplink, a.status, a.created_at AS "createdAt"
         FROM alerts a
         JOIN searches s ON s.id = a.search_id
        WHERE s.user_id = $1
        ORDER BY a.created_at DESC
        LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  static async markSent(id, client = pool) {
    await client.query(
      `UPDATE alerts SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
  }
}

module.exports = AlertModel;
