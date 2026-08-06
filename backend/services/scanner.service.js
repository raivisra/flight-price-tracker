const SearchModel = require('../models/search.model');
const AlertModel = require('../models/alert.model');
const { FlightSearchService } = require('./flight-search.service');

/**
 * Background scanner: walks every search that is due, refreshes its prices, and
 * raises alerts when the user's threshold is beaten.
 *
 * Two properties matter more than anything else here:
 *
 *   Cost. Searches are processed one at a time, and each goes through the same
 *   shared daily cache the API uses. Two users tracking RIX->HAN therefore cost
 *   ONE provider call between them, not two — the second search hits a warm
 *   cache and reports cost 0.
 *
 *   Restraint. A naive implementation alerts every single day for as long as a
 *   fare sits under the threshold, which trains users to ignore alerts. See
 *   _shouldAlert() for the suppression rules.
 */

// Re-alert only when the fare improves by at least this much on the last alert.
const MEANINGFUL_DROP = 0.03; // 3%
// ...or when this long has passed, so a standing bargain is re-surfaced.
const REMINDER_DAYS = 7;

class ScannerService {
  constructor(searchService = new FlightSearchService()) {
    this.search = searchService;
  }

  /**
   * Scan everything currently due.
   * @param {{limit?: number, dryRun?: boolean}} opts
   */
  async runDueScans({ limit = 100, dryRun = false } = {}) {
    const due = (await SearchModel.dueForScan()).slice(0, limit);
    const summary = {
      scanned: 0,
      providerCalls: 0,
      cacheHits: 0,
      alertsRaised: 0,
      failures: [],
      startedAt: new Date().toISOString()
    };

    for (const s of due) {
      try {
        const r = await this.scanOne(s, { dryRun });
        summary.scanned++;
        summary.providerCalls += r.providerCalls;
        if (r.cached) summary.cacheHits++;
        if (r.alert) summary.alertsRaised++;
      } catch (err) {
        // One bad route must not abort the whole run.
        console.error(`[scanner] search ${s.id} (${s.origin}->${s.destination}) failed:`, err.message);
        summary.failures.push({ searchId: s.id, error: err.message });
      }
    }

    summary.finishedAt = new Date().toISOString();
    console.log(
      `[scanner] ${summary.scanned} scanned, ${summary.providerCalls} provider calls, ` +
        `${summary.cacheHits} cache hits, ${summary.alertsRaised} alerts, ` +
        `${summary.failures.length} failures`
    );
    return summary;
  }

  /** Scan a single search and evaluate its alert threshold. */
  async scanOne(s, { dryRun = false } = {}) {
    const result = await this.search.searchRoute({
      origin: s.origin,
      destination: s.destination,
      departFrom: s.startDate,
      // Departure must leave room for the shortest trip to finish by endDate.
      departTo: shiftDate(s.endDate, -s.tripLengthMin),
      tripLengthMin: s.tripLengthMin,
      tripLengthMax: s.tripLengthMax,
      adults: s.adults,
      currency: s.currency,
      maxStops: s.maxStops,
      maxDurationMinutes: s.maxDurationMinutes
    });

    if (!dryRun) await SearchModel.markScanned(s.id);

    const cheapest = result.quotes[0] || null; // searchRoute sorts by price
    let alert = null;

    if (cheapest && s.alertPricePp && cheapest.pricePerPax <= s.alertPricePp) {
      const last = await AlertModel.lastForSearch(s.id);
      if (this._shouldAlert(cheapest.pricePerPax, last)) {
        alert = dryRun
          ? { wouldRaise: true, pricePerPax: cheapest.pricePerPax }
          : await AlertModel.create(s.id, {
              triggeredPricePp: cheapest.pricePerPax,
              thresholdPp: s.alertPricePp,
              departureDate: cheapest.departureDate,
              returnDate: cheapest.returnDate,
              airlineName: cheapest.airlineName,
              stops: cheapest.stops,
              durationMinutes: cheapest.durationMinutes,
              deeplink: cheapest.deeplink
            });
      }
    }

    return {
      searchId: s.id,
      route: `${s.origin}->${s.destination}`,
      provider: result.provider,
      providerCalls: result.cost,
      cached: result.cached,
      quoteCount: result.quotes.length,
      truncated: result.truncated,
      cheapestPricePp: cheapest ? cheapest.pricePerPax : null,
      alert
    };
  }

  /**
   * Suppression rules. Without these, a fare that stays below the threshold
   * would fire an alert every single day.
   *
   *   - first time under the threshold      -> alert
   *   - it dropped a further 3% or more     -> alert (genuinely better news)
   *   - a week has passed since the last    -> alert (gentle reminder)
   *   - otherwise                           -> stay quiet
   */
  _shouldAlert(pricePp, lastAlert) {
    if (!lastAlert) return true;

    const improved = pricePp <= lastAlert.triggeredPricePp * (1 - MEANINGFUL_DROP);
    if (improved) return true;

    const daysSince = (Date.now() - new Date(lastAlert.createdAt)) / 86400000;
    return daysSince >= REMINDER_DAYS;
  }
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = ScannerService;
