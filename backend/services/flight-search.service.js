const crypto = require('crypto');
const QuoteModel = require('../models/quote.model');
const { withTransaction } = require('../db/connection');
const RyanairProvider = require('../providers/ryanair.provider');
const SerpApiProvider = require('../providers/serpapi.provider');

/**
 * Cache-first flight search.
 *
 * The economics of this product live in this file. A provider call costs money
 * (or quota); a cache read costs nothing. So every search goes:
 *
 *   1. Build a normalized cache key from the query.
 *   2. Already fetched today by ANY user? -> serve from DB, zero cost.
 *   3. Another request for the same key in flight right now? -> await it
 *      instead of firing a duplicate call (cache stampede guard).
 *   4. Otherwise call the provider once, persist, and serve.
 *
 * Freshness is one calendar day, per the working assumption that fares move
 * day to day rather than hour to hour. Near the departure date that gets
 * shakier, so TTL is a candidate for tiering later (see NOTE below).
 */

// Key -> Promise, for requests currently hitting a provider.
// In-process only: with multiple API instances this would need a Postgres
// advisory lock or Redis to be effective across processes.
const inFlight = new Map();

// Provider calls allowed for one grid scan when no range provider covers the
// route. Deliberately small: SerpApi's free tier is 250 searches/MONTH, so an
// unbudgeted 118-pair scan would consume half of it in one request.
const DEFAULT_GRID_BUDGET = 6;

class FlightSearchService {
  /**
   * Provider order is COST order, not preference: _pickProvider takes the first
   * one that covers the route, so free sources must come first. Ryanair (free,
   * unmetered) gets first refusal on its own network; SerpApi (250 searches/mo
   * free, then paid) catches everything Ryanair does not fly — notably all
   * long-haul.
   */
  constructor(providers = [new RyanairProvider(), new SerpApiProvider()]) {
    this.providers = providers;
  }

  /**
   * Broad, cheap search across a date window.
   * @returns {Promise<{quotes: Array, cached: boolean, provider: string, cost: number}>}
   */
  async searchRange(query) {
    const q = normalizeQuery(query);
    const provider = await this._pickProvider(q);

    if (!provider) {
      return {
        quotes: [],
        truncated: false,
        cached: false,
        provider: null,
        cost: 0,
        note: `No provider covers ${q.origin}->${q.destination || 'anywhere'}`
      };
    }

    const cacheKey = buildCacheKey(provider.name, q);

    // 2. Warm cache?
    const hit = await QuoteModel.findFreshCache(cacheKey);
    if (hit) return this._fromCache(hit, provider);

    // 3. Someone else already fetching this exact query?
    if (inFlight.has(cacheKey)) {
      await inFlight.get(cacheKey).catch(() => {});
      const second = await QuoteModel.findFreshCache(cacheKey);
      if (second) return this._fromCache(second, provider);
      // The in-flight attempt failed; fall through and try ourselves.
    }

    // 4. Cold: one provider call, shared by everyone who asks today.
    const work = this._fetchAndStore(provider, q, cacheKey);
    inFlight.set(cacheKey, work);
    try {
      const { quotes, truncated } = await work;
      return { quotes, truncated, cached: false, provider: provider.name, cost: 1 };
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  /**
   * Specific route across a date window.
   *
   * Prefers a range-capable provider (Ryanair: one free call for the whole
   * window). When none covers the route — which is every long-haul route — it
   * falls back to sampling date pairs through SerpApi's per-date engine under a
   * hard call budget, because there is no range endpoint for a named route.
   *
   * The whole sampled grid is ONE cache entry, so the second user to ask about
   * the route today pays nothing.
   *
   * @param {Object} query   as searchRange, plus:
   * @param {number} query.maxCalls  provider-call ceiling for the grid fallback
   */
  async searchRoute(query) {
    const q = normalizeQuery(query);
    if (!q.destination) return this.searchRange(query);

    // 1. Free range provider for this exact route?
    const rangeProvider = await this._pickProvider(q);
    if (rangeProvider) return this.searchRange(query);

    // 2. Grid fallback.
    const grid = this.providers.find((p) => typeof p.searchDateGrid === 'function');
    if (!grid) {
      return {
        quotes: [],
        truncated: false,
        cached: false,
        provider: null,
        cost: 0,
        note: `No provider covers ${q.origin}->${q.destination}`
      };
    }

    const maxCalls = Math.max(1, parseInt(query.maxCalls, 10) || DEFAULT_GRID_BUDGET);
    const allPairs = buildDatePairs(q);
    const pairs = samplePairs(allPairs, maxCalls);

    // Budget and sampling are part of the identity of this result: a 5-call
    // scan is not the same answer as a 30-call scan, so both go in the key.
    const cacheKey = `${buildCacheKey(grid.name, q)}:grid${maxCalls}`;

    const hit = await QuoteModel.findFreshCache(cacheKey);
    if (hit) return this._fromCache(hit, grid);

    if (inFlight.has(cacheKey)) {
      await inFlight.get(cacheKey).catch(() => {});
      const second = await QuoteModel.findFreshCache(cacheKey);
      if (second) return this._fromCache(second, grid);
    }

    const work = this._fetchGridAndStore(grid, q, cacheKey, pairs, allPairs.length);
    inFlight.set(cacheKey, work);
    try {
      const r = await work;
      return {
        quotes: r.quotes,
        truncated: r.truncated,
        cached: false,
        provider: grid.name,
        cost: r.callsUsed,
        note: r.skipped
          ? `Sampled ${pairs.length} of ${allPairs.length} date pairs (budget ${maxCalls} calls)`
          : undefined
      };
    } finally {
      inFlight.delete(cacheKey);
    }
  }

  async _fetchGridAndStore(provider, q, cacheKey, pairs, totalPairs) {
    const started = Date.now();
    const res = await provider.searchDateGrid({
      origin: q.origin,
      destination: q.destination,
      datePairs: pairs,
      adults: q.adults,
      currency: q.currency,
      maxStops: q.maxStops,
      maxCalls: pairs.length
    });
    const durationMs = Date.now() - started;
    // maxStops was pushed to the provider, but duration was not, and providers
    // are inconsistent about honouring stop filters — so filter again here.
    const quotes = applyQualityFilters(res.quotes, q);

    await withTransaction(async (client) => {
      const cacheId = await QuoteModel.recordCache(
        {
          cacheKey,
          provider: provider.name,
          origin: q.origin,
          destination: q.destination,
          departFrom: q.departFrom,
          departTo: q.departTo,
          returnFrom: q.returnFrom,
          returnTo: q.returnTo,
          tripLengthMin: q.tripLengthMin,
          tripLengthMax: q.tripLengthMax,
          adults: q.adults,
          resultCount: quotes.length,
          truncated: res.truncated || pairs.length < totalPairs,
          durationMs
        },
        client
      );
      await QuoteModel.insertQuotes(quotes, cacheId, client);
    });

    return {
      quotes: quotes.slice().sort((a, b) => a.pricePerPax - b.pricePerPax),
      truncated: res.truncated || pairs.length < totalPairs,
      callsUsed: res.callsUsed,
      skipped: totalPairs - pairs.length
    };
  }

  async _fromCache(cacheRow, provider) {
    const quotes = cacheRow.result_count > 0
      ? await QuoteModel.findByCacheId(cacheRow.id)
      : [];
    return {
      quotes,
      truncated: cacheRow.truncated,
      cached: true,
      provider: provider.name,
      cost: 0
    };
  }

  // ---------------------------------------------------------------- internals

  async _fetchAndStore(provider, q, cacheKey) {
    const started = Date.now();
    const raw = await provider.searchRange(q);
    const truncated = raw.truncated;
    const quotes = applyQualityFilters(raw.quotes, q);
    const durationMs = Date.now() - started;

    await withTransaction(async (client) => {
      const cacheId = await QuoteModel.recordCache(
        {
          cacheKey,
          provider: provider.name,
          origin: q.origin,
          destination: q.destination,
          departFrom: q.departFrom,
          departTo: q.departTo,
          returnFrom: q.returnFrom,
          returnTo: q.returnTo,
          tripLengthMin: q.tripLengthMin,
          tripLengthMax: q.tripLengthMax,
          adults: q.adults,
          resultCount: quotes.length,
          truncated,
          durationMs
        },
        client
      );
      if (quotes.length) {
        await QuoteModel.insertQuotes(quotes, cacheId, client);
      }
    });

    return {
      quotes: quotes.slice().sort((a, b) => a.pricePerPax - b.pricePerPax),
      truncated
    };
  }

  /** First provider that both covers the route and supports range search. */
  async _pickProvider(q) {
    for (const p of this.providers) {
      if (!p.supportsRange) continue;
      try {
        if (await p.supports(q.origin, q.destination)) return p;
      } catch (err) {
        console.warn(`[search] ${p.name}.supports() failed: ${err.message}`);
      }
    }
    return null;
  }
}

/**
 * Normalize so that queries that mean the same thing produce the same key.
 * Without this, "rix"/"RIX" or a missing vs explicit trip length would each
 * cost a separate provider call.
 */
function normalizeQuery(query) {
  const iata = (v) => (v ? String(v).trim().toUpperCase() : null);
  return {
    origin: iata(query.origin),
    destination: iata(query.destination),
    departFrom: isoDate(query.departFrom),
    departTo: isoDate(query.departTo || query.departFrom),
    returnFrom: isoDate(query.returnFrom),
    returnTo: isoDate(query.returnTo),
    tripLengthMin: intOrNull(query.tripLengthMin),
    tripLengthMax: intOrNull(query.tripLengthMax ?? query.tripLengthMin),
    adults: Math.max(1, parseInt(query.adults, 10) || 1),
    currency: (query.currency || 'EUR').toUpperCase(),
    // Quality filters. maxStops is pushed down to the provider where possible
    // (SerpApi filters at source, same call cost, less junk back);
    // maxDurationMinutes always has to be applied on our side.
    maxStops: intOrNull(query.maxStops),
    maxDurationMinutes: intOrNull(query.maxDurationMinutes)
  };
}

/**
 * Drop itineraries that fail the quality filters. Kept separate from the
 * providers so every source is held to the same standard.
 */
function applyQualityFilters(quotes, { maxStops, maxDurationMinutes }) {
  if (maxStops == null && maxDurationMinutes == null) return quotes;
  return quotes.filter((q) => {
    if (maxStops != null && q.stops != null && q.stops > maxStops) return false;
    if (
      maxDurationMinutes != null &&
      q.durationMinutes != null &&
      q.durationMinutes > maxDurationMinutes
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Short, collision-resistant key. Hashed because the raw tuple exceeds the
 * varchar(255) column once destinations and windows are included.
 */
function buildCacheKey(providerName, q) {
  const tuple = [
    providerName,
    q.origin,
    q.destination || 'ANY',
    q.departFrom,
    q.departTo,
    q.returnFrom || '-',
    q.returnTo || '-',
    q.tripLengthMin ?? '-',
    q.tripLengthMax ?? '-',
    q.adults,
    q.currency,
    // Filters change what was actually fetched (SerpApi applies maxStops at
    // source), so they are part of this result's identity.
    q.maxStops ?? '-',
    q.maxDurationMinutes ?? '-'
  ].join('|');
  const hash = crypto.createHash('sha1').update(tuple).digest('hex').slice(0, 16);
  // Readable prefix keeps the table debuggable by eye.
  return `${providerName}:${q.origin}-${q.destination || 'ANY'}:${hash}`;
}

/**
 * Every departure/return pair implied by the window and trip-length span.
 * A two-month window with 14-15 day trips yields ~118 pairs — which is exactly
 * why samplePairs() exists.
 */
function buildDatePairs({ departFrom, departTo, tripLengthMin, tripLengthMax }) {
  if (!departFrom) return [];
  const from = new Date(`${departFrom}T00:00:00Z`);
  const to = new Date(`${departTo || departFrom}T00:00:00Z`);
  const lenMin = tripLengthMin ?? 0;
  const lenMax = tripLengthMax ?? lenMin;

  const pairs = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    for (let len = lenMin; len <= lenMax; len++) {
      const ret = new Date(d);
      ret.setUTCDate(ret.getUTCDate() + len);
      pairs.push([d.toISOString().slice(0, 10), len > 0 ? ret.toISOString().slice(0, 10) : null]);
    }
  }
  return pairs;
}

/**
 * Evenly spaced subset, so the sample spans the whole window instead of
 * covering only its first days. Returns everything when it already fits.
 */
function samplePairs(pairs, maxCalls) {
  if (pairs.length <= maxCalls) return pairs;
  const step = pairs.length / maxCalls;
  const out = [];
  for (let i = 0; i < maxCalls; i++) out.push(pairs[Math.floor(i * step)]);
  return out;
}

function isoDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// NOTE: freshness is a flat one calendar day. Two refinements worth making
// once there is real traffic:
//   - shorten TTL for departures inside ~21 days, where fares move faster
//   - lengthen it for windows months out, where daily scanning is waste
module.exports = { FlightSearchService, buildCacheKey, normalizeQuery };
