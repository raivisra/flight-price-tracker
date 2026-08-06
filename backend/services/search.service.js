const SearchModel = require('../models/search.model');
const { validateAirportCode } = require('../utils/validators');

// Ceilings that exist to stop one search from consuming a month of API quota.
const MAX_WINDOW_DAYS = 365;
const MAX_TRIP_LENGTH = 90;

class SearchService {
  static async create(userId, body) {
    const s = this._validate(body);
    return SearchModel.create(userId, s);
  }

  static async list(userId) {
    return SearchModel.listByUser(userId);
  }

  static async get(id, userId) {
    const found = await SearchModel.findById(id, userId);
    if (!found) throw { status: 404, message: 'Search not found' };
    return found;
  }

  static async update(id, userId, body) {
    // Validate the merged result, so a patch cannot create an invalid state
    // (e.g. moving end_date before start_date one field at a time).
    const current = await this.get(id, userId);
    const merged = this._validate({ ...current, ...body }, { partial: true });
    const updated = await SearchModel.update(id, userId, merged);
    if (!updated) throw { status: 404, message: 'Search not found' };
    return updated;
  }

  static async remove(id, userId) {
    const ok = await SearchModel.remove(id, userId);
    if (!ok) throw { status: 404, message: 'Search not found' };
    return { deleted: true };
  }

  // ---------------------------------------------------------------- internals

  static _validate(b, { partial = false } = {}) {
    const err = (message) => {
      throw { status: 400, message };
    };

    const origin = (b.origin || '').toUpperCase();
    const destination = (b.destination || '').toUpperCase();
    if (!validateAirportCode(origin)) err('origin must be a 3-letter IATA code');
    if (!validateAirportCode(destination)) err('destination must be a 3-letter IATA code');
    if (origin === destination) err('origin and destination must differ');

    const startDate = isoDate(b.startDate);
    const endDate = isoDate(b.endDate);
    if (!startDate) err('startDate must be YYYY-MM-DD');
    if (!endDate) err('endDate must be YYYY-MM-DD');
    if (endDate <= startDate) err('endDate must be after startDate');

    const windowDays = Math.round(
      (new Date(endDate) - new Date(startDate)) / 86400000
    );
    if (windowDays > MAX_WINDOW_DAYS) {
      err(`search window may not exceed ${MAX_WINDOW_DAYS} days`);
    }

    const tripLengthMin = int(b.tripLengthMin);
    const tripLengthMax = int(b.tripLengthMax ?? b.tripLengthMin);
    if (!tripLengthMin || tripLengthMin < 1) err('tripLengthMin must be at least 1');
    if (tripLengthMax < tripLengthMin) err('tripLengthMax must be >= tripLengthMin');
    if (tripLengthMax > MAX_TRIP_LENGTH) {
      err(`tripLengthMax may not exceed ${MAX_TRIP_LENGTH} days`);
    }
    // A trip has to fit inside the window, else the search can never match.
    if (tripLengthMin > windowDays) {
      err(`tripLengthMin (${tripLengthMin}) does not fit in a ${windowDays}-day window`);
    }

    const adults = int(b.adults) || 1;
    if (adults < 1 || adults > 9) err('adults must be between 1 and 9');

    const maxStops = b.maxStops === undefined || b.maxStops === null
      ? 1
      : int(b.maxStops);
    if (maxStops < 0 || maxStops > 3) err('maxStops must be between 0 and 3');

    const maxDurationMinutes = b.maxDurationMinutes === undefined || b.maxDurationMinutes === null
      ? 1200
      : int(b.maxDurationMinutes);
    if (maxDurationMinutes < 60) err('maxDurationMinutes must be at least 60');

    let alertPricePp = null;
    if (b.alertPricePp !== undefined && b.alertPricePp !== null && b.alertPricePp !== '') {
      alertPricePp = Number(b.alertPricePp);
      if (!(alertPricePp > 0)) err('alertPricePp must be a positive number');
    }

    const scanFrequency = (b.scanFrequency || 'daily').toLowerCase();
    if (!['daily', 'weekly'].includes(scanFrequency)) {
      err("scanFrequency must be 'daily' or 'weekly'");
    }

    const status = b.status || 'active';
    if (!['active', 'paused', 'archived'].includes(status)) {
      err("status must be 'active', 'paused' or 'archived'");
    }

    return {
      label: b.label ? String(b.label).slice(0, 100) : null,
      origin,
      destination,
      startDate,
      endDate,
      tripLengthMin,
      tripLengthMax,
      adults,
      currency: (b.currency || 'EUR').toUpperCase(),
      maxStops,
      maxDurationMinutes,
      alertPricePp,
      scanFrequency,
      ...(partial && { status })
    };
  }
}

function isoDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function int(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

module.exports = SearchService;
