/**
 * FlightProvider — contract every data source must implement.
 *
 * Two search methods, because they have wildly different costs:
 *
 *   searchRange()  cheap & broad. One call covers a whole date window and a
 *                  range of trip lengths. This is how we find candidate dates
 *                  without burning quota. Ryanair and SerpApi's Deals API both
 *                  support this natively.
 *
 *   searchExact()  expensive & precise. One call = one date pair. Used only to
 *                  confirm a price and get a booking link once searchRange has
 *                  narrowed things down to a handful of dates.
 *
 * Every provider returns the SAME normalized quote shape so the rest of the
 * app never has to know which source the data came from.
 */

/**
 * @typedef {Object} Quote
 * @property {string}  origin           IATA, uppercase
 * @property {string}  destination      IATA, uppercase
 * @property {string}  departureDate    YYYY-MM-DD
 * @property {string?} returnDate       YYYY-MM-DD, null for one-way
 * @property {number}  pricePerPax      in `currency`
 * @property {number}  priceTotal       pricePerPax * adults, as quoted
 * @property {string}  currency         ISO 4217
 * @property {number}  adults
 * @property {string?} airlineCode      IATA, 2 chars
 * @property {string?} airlineName
 * @property {number?} stops            0 = direct
 * @property {number?} durationMinutes
 * @property {string?} deeplink         booking URL
 * @property {string}  provider         provider name
 */

class FlightProvider {
  /** Short stable id, stored in query_cache.provider and price_quotes.provider. */
  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  /** True if this provider natively handles a date window in one call. */
  get supportsRange() {
    return false;
  }

  /**
   * Can this provider serve this route at all?
   * Ryanair, for example, only flies its own point-to-point network, so asking
   * it about RIX->HAN is a wasted call.
   * @param {string} origin
   * @param {string?} destination  null = "anywhere" search
   * @returns {Promise<boolean>}
   */
  async supports(origin, destination) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement supports()`);
  }

  /**
   * Broad search across a date window.
   * @param {Object}  p
   * @param {string}  p.origin
   * @param {string?} p.destination     null = cheapest anywhere from origin
   * @param {string}  p.departFrom      YYYY-MM-DD
   * @param {string}  p.departTo        YYYY-MM-DD
   * @param {string?} p.returnFrom      YYYY-MM-DD
   * @param {string?} p.returnTo        YYYY-MM-DD
   * @param {number?} p.tripLengthMin   days
   * @param {number?} p.tripLengthMax   days
   * @param {number}  p.adults
   * @param {string}  p.currency
   * @returns {Promise<{quotes: Quote[], truncated: boolean}>}
   *   `truncated` must be true when the provider capped the result set, so
   *   callers never present a partial list as complete.
   */
  async searchRange(p) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement searchRange()`);
  }

  /**
   * Single date pair, for price confirmation and booking links.
   * Providers that cannot do this may leave it unimplemented.
   * @returns {Promise<Quote[]>}
   */
  async searchExact(p) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement searchExact()`);
  }
}

module.exports = FlightProvider;
