#!/bin/sh
set -e

echo "[startup] Running database migrations..."
node packages/db/dist/migrate.js

echo "[startup] Running database seed (idempotent)..."
node packages/db/dist/seed.js

echo "[startup] Starting API server..."
exec node apps/api/dist/server.js
