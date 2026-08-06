const axios = require('axios');
const FlightProvider = require('./base.provider');

/**
 * Ryanair Farefinder — public, no API key, no auth, no rate limit published.
 * Official developer portal: https://developer.ryanair.com/farefinder-api
 *
 * Why this provider is first-class despite covering only one airline:
 *   - It is free and officially public (Ryanair wants the referral traffic).
 *   - It natively accepts a departure window, a return window AND a trip-length
 *     range in a single request, so one call replaces ~120 date-pair queries.
 *   - Omitting the destination returns the cheapest destinations anywhere,
 *     which is exactly the "I don't know where, just somewhere cheap" use case.
 *
 * Limits to be aware of: Ryanair metal only, point-to-point only (so `stops`
 * is always 0), and roughly 200-250 routes network-wide.
 */

const BASE = 'https://services-api.ryanair.com';
const ROUTES_TTL_MS = 24 * 60 * 60 * 1000;

// Verified against the live API on 2026-08-05:
//   - limit > 20 is rejected with {"code":"InvalidLimit"}
//   - `offset` is silently IGNORED — offset=0/20/40 all return the same 20 rows
// So 20 is a hard ceiling per request and pagination is impossible. Results
// come back price-ascending, so a truncated "anywhere" search still returns the
// 20 cheapest, which is what that search actually means. When the ceiling is
// hit we say so (see `truncated`) rather than pretending the list is complete.
// For genuinely exhaustive coverage, iterate the route list one destination at
// a time — calls are free, just slower.
const MAX_RESULTS = 20;

class RyanairProvider extends FlightProvider {
  constructor({ timeout = 15000 } = {}) {
    super();
    this.http = axios.create({
      baseURL: BASE,
      timeout,
      headers: {
        // Ryanair returns 403 to requests with no plausible UA.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json'
      }
    });
    // origin -> { at: epochMs, codes: Set<string> }
    this._routeCache = new Map();
  }

  get name() {
    return 'ryanair';
  }

  get supportsRange() {
    return true;
  }

  /**
   * Ryanair only flies its own network, so check the route exists before
   * spending a fare call on it.
   */
  async supports(origin, destination) {
    const codes = await this._routesFrom(origin);
    if (!codes) return false;
    if (!destination) return codes.size > 0; // "anywhere" search
    return codes.has(destination.toUpperCase());
  }

  async searchRange({
    origin,
    destination = null,
    departFrom,
    departTo,
    returnFrom = null,
    returnTo = null,
    tripLengthMin = null,
    tripLengthMax = null,
    adults = 1,
    currency = 'EUR'
  }) {
    const params = {
      departureAirportIataCode: origin.toUpperCase(),
      outboundDepartureDateFrom: departFrom,
      outboundDepartureDateTo: departTo,
      currency,
      limit: MAX_RESULTS
    };
    if (destination) params.arrivalAirportIataCode = destination.toUpperCase();
    if (returnFrom) params.inboundDepartureDateFrom = returnFrom;
    if (returnTo) params.inboundDepartureDateTo = returnTo;
    if (tripLengthMin != null) params.durationFrom = tripLengthMin;
    if (tripLengthMax != null) params.durationTo = tripLengthMax;

    // Round trip when a return window is given, one-way otherwise.
    const roundTrip = Boolean(returnFrom || returnTo || tripLengthMin != null);
    const path = roundTrip
      ? '/farfnd/v4/roundTripFares'
      : '/farfnd/v4/oneWayFares';

    const { data } = await this.http.get(path, { params });
    const fares = data?.fares || [];

    const quotes = fares
      .map((f) => this._normalize(f, { adults, currency, roundTrip }))
      .filter(Boolean);

    // Exactly MAX_RESULTS back means the API almost certainly had more to give.
    const truncated = fares.length >= MAX_RESULTS;
    if (truncated) {
      console.warn(
        `[ryanair] ${origin}->${destination || 'ANY'} ${departFrom}..${departTo} ` +
          `hit the ${MAX_RESULTS}-result ceiling; cheapest ${quotes.length} returned`
      );
    }

    return { quotes, truncated };
  }

  /**
   * Cheapest fare for each day of a month, one direction.
   * Useful for charting a route's shape without spending many calls.
   * @returns {Promise<Array<{date: string, pricePerPax: number, soldOut: boolean}>>}
   */
  async cheapestPerDay({ origin, destination, month, currency = 'EUR' }) {
    const { data } = await this.http.get(
      `/farfnd/v4/oneWayFares/${origin.toUpperCase()}/${destination.toUpperCase()}/cheapestPerDay`,
      { params: { outboundMonthOfDate: month, currency } }
    );
    return (data?.outbound?.fares || [])
      .filter((d) => d.price)
      .map((d) => ({
        date: d.day,
        pricePerPax: d.price.value,
        soldOut: Boolean(d.soldOut)
      }));
  }

  // ---------------------------------------------------------------- internals

  _normalize(fare, { adults, currency, roundTrip }) {
    const out = fare.outbound;
    if (!out?.departureDate) return null;

    const inb = roundTrip ? fare.inbound : null;
    // Ryanair quotes per-passenger; summary.price is the per-pax round-trip total.
    const perPax = fare.summary?.price?.value ?? out.price?.value;
    if (perPax == null) return null;

    const departureDate = out.departureDate.slice(0, 10);
    const returnDate = inb?.departureDate ? inb.departureDate.slice(0, 10) : null;

    return {
      origin: out.departureAirport.iataCode,
      destination: out.arrivalAirport.iataCode,
      departureDate,
      returnDate,
      pricePerPax: Number(perPax),
      priceTotal: Number((perPax * adults).toFixed(2)),
      currency: fare.summary?.price?.currencyCode || currency,
      adults,
      airlineCode: 'FR',
      airlineName: 'Ryanair',
      stops: 0, // point-to-point network, always direct
      durationMinutes: null, // not exposed by farefinder
      deeplink: this._deeplink({ out, inb, adults, currency }),
      provider: this.name
    };
  }

  _deeplink({ out, inb, adults, currency }) {
    const q = new URLSearchParams({
      adults: String(adults),
      dateOut: out.departureDate.slice(0, 10),
      originIata: out.departureAirport.iataCode,
      destinationIata: out.arrivalAirport.iataCode,
      isReturn: inb ? 'true' : 'false',
      currency
    });
    if (inb) q.set('dateIn', inb.departureDate.slice(0, 10));
    return `https://www.ryanair.com/en/gb/trip/flights/select?${q.toString()}`;
  }

  async _routesFrom(origin) {
    const key = origin.toUpperCase();
    const hit = this._routeCache.get(key);
    if (hit && Date.now() - hit.at < ROUTES_TTL_MS) return hit.codes;

    try {
      const { data } = await this.http.get(
        `/views/locate/searchWidget/routes/en/airport/${key}`
      );
      const codes = new Set(
        (Array.isArray(data) ? data : [])
          .map((r) => r?.arrivalAirport?.code)
          .filter(Boolean)
      );
      this._routeCache.set(key, { at: Date.now(), codes });
      return codes;
    } catch (err) {
      // Unknown airport, or Ryanair changed the endpoint. Treat as "no routes"
      // rather than throwing — the orchestrator will just skip this provider.
      console.warn(`[ryanair] route lookup failed for ${key}: ${err.message}`);
      return null;
    }
  }
}

module.exports = RyanairProvider;
