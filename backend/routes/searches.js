const express = require('express');
const router = express.Router();
const SearchService = require('../services/search.service');
const AlertModel = require('../models/alert.model');
const QuoteModel = require('../models/quote.model');
const ScannerService = require('../services/scanner.service');

const scanner = new ScannerService();

// Every handler below is mounted behind verifyToken, so req.user.user_id is
// trusted and is always used as the ownership scope — never a body/query value.

/** POST /api/searches — start tracking a route */
router.post('/', async (req, res, next) => {
  try {
    const search = await SearchService.create(req.user.user_id, req.body);
    res.status(201).json(search);
  } catch (err) {
    next(err);
  }
});

/** GET /api/searches — this user's tracked routes */
router.get('/', async (req, res, next) => {
  try {
    res.json(await SearchService.list(req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/searches/alerts/all — this user's alert log.
 * MUST stay above /:id — Express matches in declaration order, so otherwise
 * this request would bind id="alerts" and 404.
 */
router.get('/alerts/all', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    res.json(await AlertModel.listByUser(req.user.user_id, limit));
  } catch (err) {
    next(err);
  }
});

/** GET /api/searches/:id */
router.get('/:id', async (req, res, next) => {
  try {
    res.json(await SearchService.get(req.params.id, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/searches/:id */
router.patch('/:id', async (req, res, next) => {
  try {
    res.json(await SearchService.update(req.params.id, req.user.user_id, req.body));
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/searches/:id — soft delete */
router.delete('/:id', async (req, res, next) => {
  try {
    res.json(await SearchService.remove(req.params.id, req.user.user_id));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/searches/:id/scan — scan this search now.
 * ?dryRun=true evaluates the alert without recording one.
 */
router.post('/:id/scan', async (req, res, next) => {
  try {
    const search = await SearchService.get(req.params.id, req.user.user_id);
    const result = await scanner.scanOne(search, {
      dryRun: req.query.dryRun === 'true'
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/searches/:id/history — cheapest observed price per day */
router.get('/:id/history', async (req, res, next) => {
  try {
    const s = await SearchService.get(req.params.id, req.user.user_id);
    const history = await QuoteModel.priceHistory({
      origin: s.origin,
      destination: s.destination,
      days: Math.min(parseInt(req.query.days, 10) || 90, 730)
    });
    res.json({ searchId: s.id, route: `${s.origin}-${s.destination}`, history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
