# Flight Price Tracker 🛫

Intelligent flight price monitoring with local LLM insights. Powered by Travelpayouts API + Ollama (Mistral).

**Features:**
- 🔍 Real-time Price Monitoring
- 🤖 AI Insights (local LLM, no cloud)
- 📊 Price History & Trends
- 🚨 Smart Alerts
- 🌍 Multi-destination Support
- 🔒 Secure JWT Authentication

---

## 📋 SETUP FROM ZERO (Empty Windows Machine)

### STEP 1: Install Prerequisites

#### 1️⃣ **Git** (Version Control)
```bash
# Download from: https://git-scm.com/download/win
# Run installer, default settings
# Verify: git --version
```

#### 2️⃣ **Docker Desktop** (Containers)
```bash
# Download: https://www.docker.com/products/docker-desktop
# Run installer, default settings
# ⚠️ Enable WSL2 (will prompt during install)
# Verify: docker --version
```

**After Docker install:**
```bash
# Restart computer (WSL2 requires reboot)
# Open PowerShell/CMD and verify:
docker --version
docker ps  # Should show: CONTAINER ID ... (empty list ok)
```

#### 3️⃣ **Travelpayouts API Token**
```bash
# Get from: https://www.travelpayouts.com/programs/100/tools/api
# Sign up → API section → Copy token
# Example: e9c0581758af551d3fe17cb4e1085a00
```

---

### STEP 2: Clone Project

```bash
# Open PowerShell/CMD

# Navigate to where you want project
cd C:\Users\YourUsername\Documents

# Clone repository
git clone https://github.com/raivisra/flight-price-tracker.git

cd flight-price-tracker
```

---

### STEP 3: Configure Environment

```bash
# Copy template
copy .env.example .env

# Edit .env in Notepad
notepad .env
```

**Update in `.env`:**
```
TRAVELPAYOUTS_TOKEN=YOUR_TOKEN_HERE
DB_PASSWORD=travelai_dev_pwd
JWT_SECRET=your_jwt_secret_change_in_production
```

Save file (Ctrl+S).

---

### STEP 4: Start Docker Services

```bash
# Ensure Docker Desktop is running
# (Check system tray for Docker icon)

# Build & start all containers
docker-compose up --build

# First run: takes 2-3 minutes (downloads images)
# Subsequent runs: instant
```

**Expected output:**
```
travelai-db     | database system is ready
travelai-api    | Running on http://localhost:3000
travelai-llm    | Listening on 0.0.0.0:11434
```

---

### STEP 5: Test Services

**Open new PowerShell window** (keep docker-compose running):

```bash
# Test API health
curl http://localhost:3000/health

# Should return:
# {"status":"OK","timestamp":"2026-08-04T...","environment":"development"}
```

---

### STEP 6: Setup LLM (First Time Only)

**In new PowerShell:**

```bash
# Enter Ollama container
docker exec -it travelai-llm bash

# Download Mistral model (~4GB, takes 5-10 min)
ollama pull mistral

# Test it
ollama run mistral "Best time to visit Vietnam in 2027?"

# Exit
exit
```

**Next time:** Model cached, starts instantly ✓

---

## 🎯 Verify Full Setup

### Health Check Endpoints

```bash
# API Health
curl http://localhost:3000/health

# API Version
curl http://localhost:3000/api/version

# Expected output:
# {"version":"0.1.0","services":{"database":"✓","llm":"✓","travelpayouts":"✓"}}
```

### Database Check

```bash
# Connect to PostgreSQL
docker exec -it travelai-db psql -U travelai -d travelai_db

# In psql:
\dt                    -- List tables
SELECT COUNT(*) FROM users;  -- Check users table
\q                     -- Exit
```

### Test Authentication

```powershell
# Register new user
$body = @{
  username = "testuser"
  email = "test@example.com"
  password = "TestPassword123"
  password_confirm = "TestPassword123"
} | ConvertTo-Json

curl -X POST http://localhost:3000/api/auth/register `
  -ContentType "application/json" `
  -Body $body

# Login
$loginBody = @{
  email = "test@example.com"
  password = "TestPassword123"
} | ConvertTo-Json

curl -X POST http://localhost:3000/api/auth/login `
  -ContentType "application/json" `
  -Body $loginBody
```

---

## 📊 Project Structure

```
flight-price-tracker/
├── docker-compose.yml      ← All services defined
├── .env.example            ← Copy to .env
├── .gitignore              ← Git rules
├── README.md               ← This file
│
└── backend/
    ├── Dockerfile          ← Node.js image
    ├── server.js           ← Express entry point
    ├── package.json        ← Dependencies
    │
    ├── routes/
    │   └── auth.js         ← Register/Login endpoints
    ├── services/
    │   └── auth.service.js ← Business logic
    ├── models/
    │   └── user.model.js   ← Database queries
    ├── middleware/
    │   ├── auth.middleware.js      ← JWT verification
    │   └── security.middleware.js  ← Rate limiting, Helmet
    ├── utils/
    │   └── validators.js   ← Input validation
    └── db/
        ├── init.sql        ← Database schema
        └── connection.js   ← DB connection pool
```

## Project Structure

```
flight-price-tracker/
├── docker-compose.yml          # All services defined here
├── .env.example                # Template (copy to .env)
├── .gitignore                  # Git rules
├── README.md                   # This file
│
└── backend/
    ├── Dockerfile              # Node.js image
    ├── server.js               # Express app entry
    ├── package.json
    ├── routes/                 # API endpoints (TODO)
    ├── services/               # Business logic (TODO)
    └── db/
        └── init.sql            # Database schema
```

## API Endpoints (TODO)

```
POST /api/searches           - Create new search
GET  /api/searches/:id       - Get search details
GET  /api/prices/:id         - Get price history
GET  /api/insights/:id       - Get LLM insights
POST /api/alerts             - Set price alert
```

## Development

### Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f postgres
docker-compose logs -f ollama
```

### Database Access

```bash
# Connect to PostgreSQL
docker exec -it travelai-db psql -U travelai -d travelai_db

# SQL commands:
\dt                 -- List tables
SELECT * FROM users; -- Query data
\q                  -- Exit
```

### Restart Services

```bash
# Stop all
docker-compose down

# Start fresh
docker-compose up

# Remove volumes (reset database)
docker-compose down -v
```

## Troubleshooting

### Port Already in Use

```bash
# Find process on port 3000
netstat -ano | findstr :3000

# Kill it
taskkill /PID <PID> /F
```

### Ollama Not Downloading

- First run takes 5-10 min (4GB Mistral model)
- Check: `docker logs travelai-llm`
- Restart: `docker-compose restart ollama`

### Database Connection Error

```bash
# Verify Postgres is healthy
docker ps

# Check logs
docker logs travelai-db

# Reset database
docker-compose down -v
docker-compose up
```

## Moving to Another Machine

```bash
# On new machine:
git clone https://github.com/raivisra/flight-price-tracker.git
cp .env.example .env
# Edit .env with token
docker-compose up

# That's it! Everything portable.
```

## Next Steps

- [ ] Implement Travelpayouts API integration
- [ ] Build search CRUD endpoints
- [ ] Implement Ollama insights generation
- [ ] Add price alert logic
- [ ] Build React/React Native frontend

## Support

- Docs: [README.md](./README.md)
- Issues: [GitHub Issues](https://github.com/raivisra/flight-price-tracker/issues)
- API: [Travelpayouts](https://support.travelpayouts.com/)
- LLM: [Ollama](https://ollama.ai/)

---

**Happy travels!** 🌍
