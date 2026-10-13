# Multi-stage: build the React frontend, then serve it + the API from one
# Node process (backend/server.js auto-detects frontend/build and serves it).
# Build:  docker build -t festivecook .
# Run:    docker run -p 5000:5000 --env-file backend/.env festivecook

# ---- Stage 1: build frontend ----
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
# For single-service deploys REACT_APP_API_URL must stay unset so the bundle
# uses same-origin /api (see frontend/src/api/axios.js fallback). These ARGs
# default to empty; pass --build-arg only for split hosting
# (e.g. --build-arg REACT_APP_API_URL=https://your-backend.onrender.com/api).
ARG REACT_APP_API_URL=""
ARG REACT_APP_RAZORPAY_KEY_ID=""
ARG REACT_APP_GOOGLE_CLIENT_ID=""
ENV REACT_APP_API_URL=${REACT_APP_API_URL}
ENV REACT_APP_RAZORPAY_KEY_ID=${REACT_APP_RAZORPAY_KEY_ID}
ENV REACT_APP_GOOGLE_CLIENT_ID=${REACT_APP_GOOGLE_CLIENT_ID}
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# .dockerignore already excludes frontend/.env, but a stray localhost value
# from CI env would still bake in — fail the build loudly instead of shipping
# a live site that calls localhost (axios.js also guards this at runtime).
RUN if echo "$REACT_APP_API_URL" | grep -qiE "localhost|127\.0\.0\.1"; then echo "ERROR: REACT_APP_API_URL points at localhost ($REACT_APP_API_URL) — unset it for single-service deploys."; exit 1; fi; \
    npm run build

# ---- Stage 2: production server ----
FROM node:20-alpine
WORKDIR /app/backend
ENV NODE_ENV=production
# Business clock (F-08): booking math is IST-anchored in code; the pinned TZ
# keeps every other Date call consistent with it.
ENV TZ=Asia/Kolkata
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=frontend-build /app/frontend/build ../frontend/build
# Runtime uploads live on a mounted volume in production; create the dir anyway.
RUN mkdir -p uploads/cook-docs
EXPOSE 5000
CMD ["node", "server.js"]