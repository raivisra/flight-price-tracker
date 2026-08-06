const axios = require('axios');
const FlightProvider = require('./base.provider');

/**
 * SerpApi Google Flights.
 *
 * This is a paid data vendor, not scraping: we buy Google Flights results
 * under SerpApi's commercial terms. That distinction is what makes this
 * provider usable in a monetised product, unlike driving a browser ourselves.
 *
 * Free tier is 250 searches/month, and only SUCCESSFUL searches count
 * (cached/errored ones do not). Every call here is therefore treated as
 * scarce: the caller is expected to go through the shared daily cache in
 * flight-search.service.js, never straight to this class.
 *
 * Two endpoints that do genuinely different jobs (verified live 2026-08-05):
 *
 *   google_flights_deals   DISCOVERY. Takes a departure window + trip length
 *                          and returns the cheapest destinations ANYWHERE in
 *                          one call. It IGNORES arrival_id — asking it for
 *                          RIX->HAN returned 25 European cities instead. Comes
 *                          with average_price and discount_percentage per deal,
 *                          i.e. price context for free.
 *
 *   google_flights         SPECIFIC ROUTE. One exact date pair per call. No
 *                          date-range support, so scanning a window costs one
 *                          call per date pair. Returns price_insights
 *                          (lowest_price, price_level, typical_price_range),
 *                          which is a cheap trend signal without scanning
 *                          every date. Supports open-jaw via multi_city_json.
 *
 * Cost consequence: "cheapest anywhere over two months" is 1 call, but
 * "track RIX->HAN across two months" is one call per date pair. Callers must
 * therefore sample dates rather than enumerate them — see searchDateGrid().
 *
 * This is the provider for Asia long-haul, where airline-direct APIs fail: a
 * RIX->HAN one-stop is usually an interline itinerary no single carrier sells.
 */

const BASE = 'https://serpapi.com/search.json';

class SerpApiProvider extends FlightProvider {
  constructor({ apiKey = process.env.SERPAPI_KEY, timeout = 60000 } = {}) {
    super();
    this.apiKey = apiKey;
    this.http = axios.create({ timeout });
  }

  get name() {
    return 'serpapi';
  }

  /**
   * Only the "anywhere" case is a true single-call range search. A specific
   * route has no range endpoint, so it is deliberately NOT advertised as one —
   * that keeps the orchestrator from assuming a month costs one call.
   */
  get supportsRange() {
    return true;
  }

  /**
   * Range search is the Deals engine, which only does origin -> anywhere.
   * For a named destination the caller must use searchDateGrid()/searchExact(),
   * so decline here rather than silently returning the wrong thing.
   */
  async supports(origin, destination) {
    return Boolean(this.apiKey && !destination);
  }

  /**
   * DISCOVERY: cheapest destinations anywhere from `origin` within a departure
   * window and trip-length span. Exactly one provider call.
   */
  async searchRange({
    origin,
    destination = null,
    departFrom,
    departTo,
    tripLengthMin = null,
    tripLengthMax = null,
    adults = 1,
    currency = 'EUR'
  }) {
    if (!this.apiKey) throw new Error('SERPAPI_KEY is not set');
    if (destination) {
      throw new Error(
        'google_flights_deals ignores arrival_id; use searchDateGrid() for a specific route'
      );
    }

    const params = {
      engine: 'google_flights_deals',
      api_key: this.apiKey,
      departure_id: origin.toUpperCase(),
      currency,
      adults,
      hl: 'en',
      // A range is expressed as two comma-separated dates.
      outbound_date: departFrom === departTo ? departFrom : `${departFrom},${departTo}`,
      type: '1' // round trip
    };
    if (tripLengthMin != null && tripLengthMax != null) {
      params.trip_length = tripLengthMin === tripLengthMax
        ? String(tripLengthMin)
        : `${tripLengthMin},${tripLengthMax}`;
    }

    const data = await this._get(params);
    const quotes = (data.deals || [])
      .map((d) => this._normalizeDeal(d, { origin, adults, currency }))
      .filter(Boolean);

    return {
      quotes,
      // Deals is a curated "best offers" list, never an exhaustive enumeration.
      truncated: quotes.length > 0
    };
  }

  /**
   * SPECIFIC ROUTE across a window. There is no range endpoint, so this issues
   * one call per date pair and is therefore budgeted: `maxCalls` is a hard cap
   * and the caller is told how many were actually spent.
   *
   * @param {Object}   p
   * @param {string[]} p.datePairs  [[departISO, returnISO], ...] already sampled
   * @param {number}   p.maxCalls   hard ceiling on provider calls
   * @returns {Promise<{quotes: Quote[], truncated: boolean, callsUsed: number,
   *                    priceInsights: Object|null, skipped: number}>}
   */
  async searchDateGrid({
    origin,
    destination,
    datePairs,
    adults = 1,
    currency = 'EUR',
    maxStops = null,
    maxCalls = 10
  }) {
    if (!this.apiKey) throw new Error('SERPAPI_KEY is not set');
    if (!destination) throw new Error('searchDateGrid requires a destination');

    const budgeted = datePairs.slice(0, maxCalls);
    const skipped = datePairs.length - budgeted.length;
    const quotes = [];
    let priceInsights = null;
    let callsUsed = 0;

    for (const [departureDate, returnDate] of budgeted) {
      const res = await this.searchExact({
        origin,
        destination,
        departureDate,
        returnDate,
        adults,
        currency,
        maxStops
      });
      callsUsed++;
      quotes.push(...res.quotes);
      // Insights are route-level; keep the first non-null set.
      if (!priceInsights && res.priceInsights) priceInsights = res.priceInsights;
    }

    if (skipped > 0) {
      console.warn(
        `[serpapi] ${origin}->${destination}: budget ${maxCalls} calls, ` +
          `${skipped} of ${datePairs.length} date pairs NOT scanned`
      );
    }

    return { quotes, truncated: skipped > 0, callsUsed, priceInsights, skipped };
  }

  /**
   * One exact date pair. Also handles open-jaw (different return origin) by
   * switching to multi_city_json.
   */
  async searchExact({
    origin,
    destination,
    departureDate,
    returnDate = null,
    returnOrigin = null,
    returnDestination = null,
    adults = 1,
    currency = 'EUR',
    maxStops = null
  }) {
    if (!this.apiKey) throw new Error('SERPAPI_KEY is not set');

    const params = {
      engine: 'google_flights',
      api_key: this.apiKey,
      currency,
      adults,
      hl: 'en'
    };
    if (maxStops != null) params.stops = String(maxStops + 1); // Google: 1 = nonstop

    const openJaw =
      returnDate &&
      returnOrigin &&
      returnOrigin.toUpperCase() !== destination.toUpperCase();

    if (openJaw) {
      // e.g. RIX->HAN out, SGN->RIX back: two slices with unmirrored endpoints.
      params.type = '3';
      params.multi_city_json = JSON.stringify([
        {
          departure_id: origin.toUpperCase(),
          arrival_id: destination.toUpperCase(),
          date: departureDate
        },
        {
          departure_id: returnOrigin.toUpperCase(),
          arrival_id: (returnDestination || origin).toUpperCase(),
          date: returnDate
        }
      ]);
    } else {
      params.departure_id = origin.toUpperCase();
      params.arrival_id = destination.toUpperCase();
      params.outbound_date = departureDate;
      if (returnDate) {
        params.type = '1';
        params.return_date = returnDate;
      } else {
        params.type = '2';
      }
    }

    const data = await this._get(params);
    return {
      quotes: this._collect(data, {
        origin,
        destination,
        adults,
        currency,
        departureDate,
        returnDate
      }),
      truncated: false,
      priceInsights: data.price_insights || null
    };
  }

  // ---------------------------------------------------------------- internals

  async _get(params) {
    const { data } = await this.http.get(BASE, { params });
    // SerpApi reports failures in the body with HTTP 200, so check explicitly.
    if (data.error) throw new Error(`serpapi: ${data.error}`);
    return data;
  }

  /** Itineraries from the google_flights engine, both buckets. */
  _collect(data, ctx) {
    return [...(data.best_flights || []), ...(data.other_flights || [])]
      .map((it) => this._normalize(it, ctx))
      .filter(Boolean);
  }

  /**
   * google_flights itinerary -> Quote.
   *
   * IMPORTANT: `itin.price` is the TOTAL for all passengers, not per person.
   * Verified 2026-08-05 — RIX->HAN with adults=4 returned 3254, i.e. ~813 pp,
   * matching independently observed per-person fares.
   */
  _normalize(itin, { origin, destination, adults, currency, departureDate, returnDate }) {
    const legs = itin.flights || [];
    if (!legs.length || itin.price == null) return null;

    const first = legs[0];
    const last = legs[legs.length - 1];
    const total = Number(itin.price);

    return {
      origin: first.departure_airport?.id || origin.toUpperCase(),
      destination: last.arrival_airport?.id || destination.toUpperCase(),
      // Trust the dates we asked for. For round trips this engine returns only
      // the outbound legs (the return needs a second call with departure_token),
      // so deriving returnDate from `legs` would wrongly yield null.
      departureDate: departureDate || (first.departure_airport?.time || '').slice(0, 10),
      returnDate: returnDate || null,
      pricePerPax: Number((total / adults).toFixed(2)),
      priceTotal: total,
      currency,
      adults,
      airlineCode: null, // this engine returns airline names, not IATA codes
      airlineName: first.airline || null,
      // layovers is authoritative; legs.length counts segments, not stops.
      stops: Array.isArray(itin.layovers)
        ? itin.layovers.length
        : Math.max(0, legs.length - 1),
      durationMinutes: itin.total_duration ?? null,
      deeplink: itin.booking_token
        ? `https://www.google.com/travel/flights?tfs=${encodeURIComponent(itin.booking_token)}`
        : null,
      provider: this.name
    };
  }

  /**
   * google_flights_deals entry -> Quote. Flatter shape than an itinerary, and
   * it already carries the dates, stop count, airline code and a booking link.
   * `price` here is likewise the total for the queried passenger count.
   */
  _normalizeDeal(deal, { origin, adults, currency }) {
    if (deal.price == null || !deal.outbound_date) return null;
    const total = Number(deal.price);

    return {
      origin: deal.departure_airport_code || origin.toUpperCase(),
      destination: deal.arrival_airport_code,
      departureDate: deal.outbound_date,
      returnDate: deal.return_date || null,
      pricePerPax: Number((total / adults).toFixed(2)),
      priceTotal: total,
      currency,
      adults,
      airlineCode: deal.airline_code || null,
      airlineName: deal.airline || null,
      stops: deal.stops ?? null,
      durationMinutes: deal.flight_duration ?? null,
      deeplink: deal.flight_link || null,
      provider: this.name,
      // Deals-only extras: Google's own view of whether this is a good price.
      // Not persisted yet, but exactly the raw material for AI insights.
      averagePrice: deal.average_price ?? null,
      discountPercentage: deal.discount_percentage ?? null
    };
  }
}

module.exports = SerpApiProvider;
