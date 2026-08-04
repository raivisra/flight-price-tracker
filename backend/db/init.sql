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
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3) NOT NULL,
  trip_length_min INT NOT NULL CHECK (trip_length_min > 0),
  trip_length_max INT NOT NULL CHECK (trip_length_max >= trip_length_min),
  preferred_months VARCHAR(50), -- Comma-separated: 1,2,3 or JSON later
  start_date DATE,
  end_date DATE,
  max_stops INT DEFAULT 1 CHECK (max_stops >= 0),
  price_alert_limit INT CHECK (price_alert_limit > 0),
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
-- PRICE HISTORY (Optimized for Large Data)
-- ============================================

CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  origin VARCHAR(3) NOT NULL,
  destination VARCHAR(3) NOT NULL,
  departure_date DATE NOT NULL,
  return_date DATE NOT NULL,
  price_eur DECIMAL(10, 2) NOT NULL,
  price_usd DECIMAL(10, 2), -- Store in multiple currencies
  airline_code VARCHAR(3),
  airline_name VARCHAR(100),
  stops INT DEFAULT 0 CHECK (stops >= 0),
  duration_minutes INT,
  deeplink VARCHAR(500), -- Skyscanner booking link
  data_source VARCHAR(50) DEFAULT 'travelpayouts',
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(search_id, departure_date, return_date, airline_code, fetched_at)
);

-- Optimize for range queries
CREATE INDEX idx_price_history_search_dates ON price_history(search_id, departure_date, return_date);
CREATE INDEX idx_price_history_dates ON price_history(departure_date, return_date);
CREATE INDEX idx_price_history_price ON price_history(price_eur);
CREATE INDEX idx_price_history_fetched ON price_history(fetched_at DESC);

-- ============================================
-- AI INSIGHTS & ANALYSIS
-- ============================================

CREATE TABLE IF NOT EXISTS insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  insight_type VARCHAR(50) NOT NULL CHECK (insight_type IN
    ('historical_avg', 'best_months', 'holiday_alert', 'price_trend', 'prediction')),
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  confidence_score DECIMAL(3, 2) DEFAULT 0.5 CHECK (confidence_score BETWEEN 0 AND 1),
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_insights_search_id ON insights(search_id);
CREATE INDEX idx_insights_type ON insights(insight_type);
CREATE INDEX idx_insights_expires ON insights(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================
-- ALERTS & NOTIFICATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  target_price_eur INT NOT NULL CHECK (target_price_eur > 0),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'triggered', 'dismissed', 'expired')),
  triggered_at TIMESTAMP,
  triggered_price_eur INT,
  notified_at TIMESTAMP,
  notification_channel VARCHAR(50) DEFAULT 'email' CHECK (notification_channel IN ('email', 'push', 'in_app')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_alerts_search_id ON alerts(search_id);
CREATE INDEX idx_alerts_status ON alerts(status) WHERE status = 'pending';
CREATE INDEX idx_alerts_user_search ON alerts(search_id, status);

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
COMMENT ON TABLE searches IS 'Flight search configurations per user';
COMMENT ON TABLE price_history IS 'Historical price data - can grow large, consider archiving old data';
COMMENT ON TABLE insights IS 'AI-generated insights with expiration';
COMMENT ON TABLE alerts IS 'Price alert triggers';
COMMENT ON TABLE audit_log IS 'Compliance & debugging audit trail';
