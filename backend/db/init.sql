-- Flight Price Tracker Database Schema (Production-Ready)

-- ============================================
-- USERS & AUTHENTICATION
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL, -- bcrypt hash
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP -- Soft delete
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_is_active ON users(is_active) WHERE is_active = true;

-- ============================================
-- SEARCHES & PRICE TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(100),                   -- user-facing name, e.g. "Vjetnama ziema"
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3) NOT NULL,
  -- The search window. start_date/end_date bound the whole trip: departure may
  -- not precede start_date and return may not exceed end_date.
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date > start_date),
  trip_length_min INT NOT NULL CHECK (trip_length_min > 0),
  trip_length_max INT NOT NULL CHECK (trip_length_max >= trip_length_min),
  adults INT NOT NULL DEFAULT 1 CHECK (adults > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  -- Quality bar. Defaults reflect what a traveller actually accepts: at most
  -- one stop, and no 30-hour interline routings.
  max_stops INT DEFAULT 1 CHECK (max_stops >= 0),
  max_duration_minutes INT DEFAULT 1200 CHECK (max_duration_minutes > 0),
  -- Alert below this per-person price. NULL = track only, never notify.
  alert_price_pp DECIMAL(10, 2) CHECK (alert_price_pp > 0),
  -- How often the background scanner revisits this route.
  scan_frequency VARCHAR(10) NOT NULL DEFAULT 'daily'
    CHECK (scan_frequency IN ('daily', 'weekly')),
  last_scanned_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP -- Soft delete
);

CREATE INDEX idx_searches_user_id ON searches(user_id, is_active);
CREATE INDEX idx_searches_route ON searches(origin, destination);
CREATE INDEX idx_searches_status ON searches(status) WHERE is_active = true;

-- ============================================
-- QUERY CACHE (shared across ALL users)
-- ============================================
-- One row = "we asked provider X for this route+window on this date".
-- Exists so a scan that returned ZERO results is still remembered
-- (negative caching) — otherwise the cache would re-fetch forever.
-- This table is what makes the unit economics work: two users tracking
-- the same route consume ONE provider call, not two.

CREATE TABLE IF NOT EXISTS query_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key VARCHAR(255) NOT NULL,     -- normalized, see flight-search.service.js
  provider VARCHAR(50) NOT NULL,
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3),              -- NULL = "cheapest anywhere" search
  depart_from DATE NOT NULL,
  depart_to DATE NOT NULL,
  return_from DATE,
  return_to DATE,
  trip_length_min INT,
  trip_length_max INT,
  adults INT NOT NULL DEFAULT 1,
  result_count INT NOT NULL DEFAULT 0, -- 0 is a valid, cacheable answer
  truncated BOOLEAN NOT NULL DEFAULT false, -- provider capped the result set
  fetched_on DATE NOT NULL DEFAULT CURRENT_DATE,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_ms INT,
  UNIQUE (cache_key, fetched_on)       -- one fetch per key per calendar day
);

CREATE INDEX idx_query_cache_lookup ON query_cache(cache_key, fetched_on DESC);
CREATE INDEX idx_query_cache_route ON query_cache(origin, destination, fetched_on DESC);

-- ============================================
-- PRICE QUOTES (user-independent, shared)
-- ============================================
-- Deliberately has NO user_id / search_id: a fare from RIX to HAN on a
-- given date belongs to the route, not to whoever happened to ask.
-- Users are linked to these rows by MATCHING route+dates, not by FK.

CREATE TABLE IF NOT EXISTS price_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_cache_id UUID REFERENCES query_cache(id) ON DELETE SET NULL,
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3) NOT NULL,
  departure_date DATE NOT NULL,
  return_date DATE,                    -- NULL = one-way
  trip_length_days INT,                -- denormalized for fast filtering
  price_total DECIMAL(10, 2) NOT NULL, -- for the queried pax count
  price_per_pax DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  adults INT NOT NULL DEFAULT 1,
  airline_code VARCHAR(3),
  airline_name VARCHAR(100),
  stops INT CHECK (stops >= 0),
  duration_minutes INT,
  deeplink VARCHAR(1000),
  provider VARCHAR(50) NOT NULL,
  fetched_on DATE NOT NULL DEFAULT CURRENT_DATE,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  -- Deliberately NO unique constraint on the route/date tuple.
  -- One date pair legitimately has many distinct itineraries (different
  -- carriers, stop counts, durations), and Google-sourced rows carry no IATA
  -- code to tell them apart, so any such constraint would either collapse real
  -- alternatives or break ON CONFLICT ("cannot affect row a second time").
  -- Freshness is handled instead by replacing a scan's rows wholesale:
  -- QuoteModel.insertQuotes() deletes by query_cache_id before inserting.
);

-- The main read path: "cheapest for this route within this date window"
CREATE INDEX idx_quotes_route_dates ON price_quotes(origin, destination, departure_date, return_date);
CREATE INDEX idx_quotes_route_price ON price_quotes(origin, destination, price_per_pax);
CREATE INDEX idx_quotes_fetched ON price_quotes(fetched_on DESC);
CREATE INDEX idx_quotes_trip_length ON price_quotes(origin, destination, trip_length_days, price_per_pax);
CREATE INDEX idx_quotes_cache ON price_quotes(query_cache_id);

-- ============================================
-- AI INSIGHTS & ANALYSIS
-- ============================================

-- Keyed by ROUTE, not by user search — for the same reason as price_quotes.
-- "January is historically 23% cheaper for RIX-HAN" is a fact about the route;
-- generating it per user would burn LLM compute for identical output.
-- destination NULL = insight about the origin in general (e.g. "Riga in winter").

CREATE TABLE IF NOT EXISTS insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3),
  scope_month INT CHECK (scope_month BETWEEN 1 AND 12), -- NULL = not month-specific
  insight_type VARCHAR(50) NOT NULL CHECK (insight_type IN
    ('historical_avg', 'best_months', 'holiday_alert', 'price_trend', 'prediction')),
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  confidence_score DECIMAL(3, 2) DEFAULT 0.5 CHECK (confidence_score BETWEEN 0 AND 1),
  model VARCHAR(50),                    -- which LLM produced it
  sample_size INT,                      -- how many quotes it was derived from
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (origin, destination, scope_month, insight_type)
);

CREATE INDEX idx_insights_route ON insights(origin, destination);
CREATE INDEX idx_insights_type ON insights(insight_type);
CREATE INDEX idx_insights_expires ON insights(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================
-- ALERTS & NOTIFICATIONS
-- ============================================

-- An EVENT LOG, not configuration: the threshold lives on `searches`.
-- One row = "this search's threshold was beaten by this fare, on this day".
-- threshold_pp is copied in so history stays truthful after the user edits
-- their target price.

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  triggered_price_pp DECIMAL(10, 2) NOT NULL,
  threshold_pp DECIMAL(10, 2) NOT NULL,
  departure_date DATE,
  return_date DATE,
  airline_name VARCHAR(100),
  stops INT,
  duration_minutes INT,
  deeplink VARCHAR(1000),
  status VARCHAR(20) DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'dismissed', 'failed')),
  notification_channel VARCHAR(50) DEFAULT 'email'
    CHECK (notification_channel IN ('email', 'push', 'in_app')),
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_alerts_search_id ON alerts(search_id, created_at DESC);
CREATE INDEX idx_alerts_pending ON alerts(status) WHERE status = 'pending';

-- ============================================
-- AUDIT LOG (for compliance & debugging)
-- ============================================

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL, -- 'search_created', 'price_fetched', 'alert_triggered'
  entity_type VARCHAR(50), -- 'search', 'alert', 'price'
  entity_id UUID,
  changes JSONB, -- Before/after values
  ip_address VARCHAR(45),
  user_agent VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);

-- ============================================
-- SAMPLE DATA (for testing)
-- ============================================

-- Demo user: username=demo_user, password=demo123 (hash generated separately)
-- Don't use in production!
INSERT INTO users (username, email, password_hash, is_active)
VALUES (
  'demo_user',
  'demo@travelai.local',
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcg7b3XeKeUxWdeS86E36P4/KFm',
  true
)
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- COMMENTS (for developers)
-- ============================================

COMMENT ON TABLE users IS 'User accounts with authentication';
COMMENT ON TABLE searches IS 'Flight search configurations per user (what to track)';
COMMENT ON TABLE query_cache IS 'One row per provider query per day. Shared across all users - this is what keeps provider costs proportional to unique routes, not to user count. result_count = 0 is a valid cached answer (negative caching).';
COMMENT ON TABLE price_quotes IS 'Observed fares, deliberately user-independent. Grows large; archive by fetched_on.';
COMMENT ON TABLE insights IS 'AI-generated insights, keyed by route (not by user) so identical output is not regenerated per user';
COMMENT ON TABLE alerts IS 'Price alert triggers';
COMMENT ON TABLE audit_log IS 'Compliance & debugging audit trail';
