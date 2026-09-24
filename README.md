# FestiveCook — Festive Cooking & Cook Booking Platform

MERN monorepo: `backend/` (Express + MongoDB API, serves uploaded docs) and `frontend/` (React CRA app).

## Deployment-ready setup (what was added)

- **Single-service deploys**: `backend/server.js` automatically serves `frontend/build` (with SPA fallback) when it exists — API, `/uploads`, and the site all run on one process/port.
- **Configurable CORS**: set `CLIENT_URL` on the backend (comma-separated origins). Leave it empty for same-origin deploys.
- **Same-origin frontend defaults**: the frontend now falls back to `/api` (relative) instead of `http://localhost:5000`, so production builds work without baked-in localhost URLs. Set `REACT_APP_API_URL` only if you host the frontend separately.
- **Docker**: multi-stage `Dockerfile` (builds the frontend, ships it inside the backend image) + `docker-compose.yml` with MongoDB and a persistent `uploads` volume.
- **Render Blueprint**: `render.yaml` for one-click hosting (works the same on Railway/Fly/any Node host).
- **`.gitignore`**: secrets, `node_modules`, builds, logs, and runtime `uploads/` stay out of git.
- **Node 18+ engines** pinned in both `package.json` files.
- **CI/CD**: automated deployment pipeline via `Jenkinsfile` for zero-downtime Docker Compose deploys.

## Quick deploy (Docker Compose)

1. Create a `.env` file next to `docker-compose.yml` with at least:
   ```
   JWT_SECRET=<long random string>
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/festivecook?retryWrites=true&w=majority
   RAZORPAY_KEY_ID=...
   RAZORPAY_KEY_SECRET=...
   GOOGLE_CLIENT_ID=...
   ```
2. `docker compose up --build -d`
3. App on `http://localhost:5000`, data lives in your Atlas cluster.
4. Optional seed: `docker compose exec app node seeds/seed.js`
5. Offline dev with local Mongo instead: set `MONGODB_URI=mongodb://db:27017/festivecook` in that `.env` and run `docker compose --profile local-mongo up --build -d` (data persisted in the `mongo-data` volume).

## Quick deploy (AWS EC2 + Docker Compose)

1. Launch an Ubuntu 24.04 EC2 instance (`t3.medium`, open ports 22, 80, 5000 in Security Group).
2. Install Docker & Git on the server:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
   sudo usermod -aG docker ubuntu && newgrp docker
   ```
3. Clone the repo and configure `.env` (NEVER commit this file — it holds
   secrets; see `docs/SECRET_ROTATION.md`):
   ```bash
   git clone https://github.com/bhaveshS8/CookMitra.git
   cd CookMitra
   cp backend/.env.example .env
   # Generate a strong JWT secret (value is written into .env, never printed):
   node backend/scripts/rotate-secrets.js --write .env
   ```
   Then edit `.env`: set `NODE_ENV=production`, `MONGODB_URI` (Atlas SRV URI),
   live `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (from
   https://dashboard.razorpay.com/app/keys), `RAZORPAY_WEBHOOK_SECRET`,
   `GOOGLE_CLIENT_ID`, and `REACT_APP_API_URL=/api`. Leave
   `ALLOW_TEST_PAYMENTS` unset/false — the server refuses to boot in
   production while it is `true`. For real-money deploys also set
   `REQUIRE_PAYMENTS=true` so boot fails fast when payment config is missing.
4. Start the application:
   ```bash
   docker compose up --build -d
   ```
5. App is live on `http://<YOUR_EC2_PUBLIC_IP>:5000` (health check: `/api/health`).

## Quick deploy (Render / Railway / Fly / any Node host)

- **Build command**: `cd frontend && npm ci && npm run build && cd ../backend && npm ci`
- **Start command**: `cd backend && node server.js`
- **Health check**: `/api/health`
- **Env vars** (from `backend/.env.example`): `NODE_ENV=production`, `MONGODB_URI` (Atlas SRV URI), `JWT_SECRET`, Razorpay keys + `RAZORPAY_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`. Leave `CLIENT_URL` empty for same-origin.
- **Persistent disk** (important): mount a volume at `/app/backend/uploads` on Render/Fly so cook verification documents survive redeploys. On Railway, attach a volume to `/app/backend/uploads` similarly.
- On Render you can just do **New → Blueprint** and pick this repo (`render.yaml` does the above).

## MongoDB Atlas checklist

1. Create a free M0 cluster, add a database user, allow access from your host's IPs (or `0.0.0.0/0` behind platform egress notes).
2. Use the SRV connection string as `MONGODB_URI`, e.g. `mongodb+srv://user:pass@cluster.mongodb.net/festivecook?retryWrites=true&w=majority`.
3. The server keeps retrying the connection without crashing (`/api/health` reports `db` status), so a bad URI won't take the API down — but fix it before real traffic.

## Production checklist

- [ ] `NODE_ENV=production`, strong `JWT_SECRET` (never commit it).
- [ ] Razorpay **live** keys + webhook secret configured; webhook endpoint `POST <your-domain>/api/payments/webhook` registered in the Razorpay dashboard.
- [ ] `ALLOW_TEST_PAYMENTS` unset/false in production.
- [ ] Google Sign-In: add your production domain to the OAuth client's Authorized JavaScript origins in Google Cloud Console, and match `GOOGLE_CLIENT_ID` (backend) with `REACT_APP_GOOGLE_CLIENT_ID` (frontend build env).
- [ ] Persistent volume mounted for `backend/uploads`.
- [ ] HTTPS via your platform (the app sets `trust proxy`, so `req.secure` behaves correctly behind load balancers).
- [ ] Run `npm test` in `backend/` after deploys to smoke-test the core engines.

## Local development

- Backend: `cd backend && npm install && npm run dev` (uses `backend/.env`, see `.env.example`).
- Frontend: `cd frontend && npm install && npm start` (uses `frontend/.env`).
- Or run both via `start-dev.bat` (Windows).
- Tests: `cd backend && npm test`.
