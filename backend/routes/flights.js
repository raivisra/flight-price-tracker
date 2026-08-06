const express = require('express');
const router = express.Router();
const { FlightSearchService } = require('../services/flight-search.service');
const QuoteModel = require('../models/quote.model');

const search = new FlightSearchService();

/**
 * GET /api/flights/search
 *
 * Broad date-window search. Serves from the shared daily cache when possible;
 * the response says which happened via `cached` and `cost`.
 *
 * Query params:
 *   origin          required, IATA
 *   destination     optional — omit for "cheapest anywhere"
 *   departFrom      required, YYYY-MM-DD
 *   departTo        optional, defaults to departFrom
 *   returnFrom      optional, YYYY-MM-DD
 *   returnTo        optional, YYYY-MM-DD
 *   tripLengthMin   optional, days
 *   tripLengthMax   optional, days
 *   adults          optional, default 1
 *   currency        optional, default EUR
 *   maxStops        optional — 0 = direct only, 1 = one stop max
 *   maxDurationMinutes optional — drops the 30-hour interline junk
 *   maxCalls        optional — provider-call budget for long-haul grid scans
 */
router.get('/search', async (req, res, next) => {
  try {
    const { origin, departFrom } = req.query;
    if (!origin || !departFrom) {
      return res.status(400).json({ error: 'origin and departFrom are required' });
    }

    // searchRoute handles both cases: it delegates to the free range provider
    // when one covers the route, and falls back to budgeted date-grid sampling
    // when none does (all long-haul).
    const result = await search.searchRoute(req.query);

    res.json({
      cached: result.cached,
      provider: result.provider,
      providerCallsUsed: result.cost,
      count: result.quotes.length,
      // True when the provider capped the list — the response holds the
      // cheapest N, not every option. Never hide this from the caller.
      truncated: result.truncated,
      ...(result.note && { note: result.note }),
      quotes: result.quotes
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/flights/history?origin=RIX&destination=BCN&days=90
 * Cheapest observed price per day — the data behind charts and AI insights.
 */
router.get('/history', async (req, res, next) => {
  try {
    const { origin, destination, days } = req.query;
    if (!origin || !destination) {
      return res.status(400).json({ error: 'origin and destination are required' });
    }
    const history = await QuoteModel.priceHistory({
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      days: Math.min(parseInt(days, 10) || 90, 730)
    });
    res.json({ origin, destination, points: history.length, history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
