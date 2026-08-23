# Pre-Deployment Repository Cleanup Baseline Checkpoint

**Date:** 2026-08-23T14:58:40+05:30  
**Git Branch:** `main`  
**Git HEAD Commit:** `ce12ed7c876cb2bc4216ca3425a26418706914e3`  
**Working Tree Status:** Clean with newly added Firebase notification subsystem files and UI enhancement files.

---

## 1. Inventory Summary

| Category | File Count | Notes / Key Assets |
| :--- | :--- | :--- |
| **Total Tracked & Source Files** | 245 | Complete repository tree excluding `.git`, `node_modules`, `.pgdata` |
| **Source Files** | 74 | Monorepo source modules in `apps/*` and `packages/*` |
| **Test Files** | 48 | Playwright E2E suites (8), Integration suites (35), Unit tests (4), Ad-hoc probe (1) |
| **Database Migrations** | 13 | Canonical immutable migrations `0001_initial.sql` through `0013_notifications.sql` |
| **Configuration Files** | 22 | Root and package `tsconfig.json`, `package.json`, `vite.config.ts`, `playwright.config.ts` |
| **Docker & Compose Files** | 6 | `Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web`, `docker-compose.yml`, `docker-compose.production.yml` |
| **Frontend Public Assets** | 1 | `apps/web/public/firebase-messaging-sw.js` |
| **Worker Files** | 2 | `apps/worker/src/main.ts`, `apps/worker/src/worker.ts` |
| **Firebase / Push Assets** | 6 | `fcmClient.ts`, `notifications.ts`, `firebaseClient.ts`, `notificationApi.ts`, `useNotifications.ts`, `firebase-messaging-sw.js` |
| **Generated Output** | 47 | `dist/` directories, `playwright-report/`, `test-results/` |

---

## 2. Pre-Cleaning Validation Baseline Status

| Validation Command | Status | Output / Results Summary |
| :--- | :--- | :--- |
| `npm run typecheck` | **PASS (100%)** | 0 errors across 5 workspace packages (`api`, `web`, `worker`, `config`, `db`) |
| `npm run build` | **PASS (100%)** | 0 errors; Web production bundle: `543.84 kB` JS, `67.60 kB` CSS |
| `npm run test:all` | **PASS (100%)** | 14 test suites executed, **244 passed, 0 failed** |
| `npx playwright test` | **PASS (100%)** | 52 E2E user journeys executed across Desktop & Mobile, **52 passed, 0 failed** |

---

## 3. Known Conditional Test-Only Routes & Dev Components

- **`POST /v1/test/reset-tracker-rate-limit`**: Test-only route guarded by `if (config.NODE_ENV === 'production')` returning `404 NOT_FOUND` in production.
- **`POST /v1/test/seed-tracker-request`**: Test-only seeding route guarded by `NODE_ENV !== 'production'`.
- **Database Seed Scripts**: `packages/db/src/seed.ts` and `wipe-to-scratch.ts` strictly restricted to development/testing environments.
