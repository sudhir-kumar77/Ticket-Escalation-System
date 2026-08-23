# Pre-Deployment Safe Cleanup Candidates Audit

**Evaluation Standard:** Zero-Risk / Zero-Business-Rule-Change / Zero-UX-Change  
**Date:** 2026-08-23T15:03:00+05:30

---

## 1. Candidate Classifications

| File / Artifact | Classification | Reference Count | Reason & Evidence | Risk | Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tests/update_constraint.mjs` | **G. PROVABLY DEAD** | 0 | Ad-hoc development script with hardcoded `postgresql://postgres:postgres@127.0.0.1:5432/nvara_dev`. Replaced by canonical migrations `0006_expand_audit_event_types.sql` and `0012_invitation_audit_events.sql`. | ZERO | **DELETE** |
| `apps/web/src/components/ClientPortal.tsx` | **G. PROVABLY DEAD** | 0 | 1-line legacy re-export shim (`export { ClientPortal } from './client/ClientPortal'`). `App.tsx` and all consumers import directly from `./components/client/ClientPortal`. | ZERO | **DELETE** |
| `apps/web/src/components/ProductionPMPortal.tsx` | **G. PROVABLY DEAD** | 0 | 1-line legacy re-export shim (`export { ProductionPMPortal } from './pm/ProductionPMPortal'`). `App.tsx` and all consumers import directly from `./components/pm/ProductionPMPortal`. | ZERO | **DELETE** |
| `packages/db/migrations/0001_initial.sql` ... `0013_notifications.sql` | **A. REQUIRED FOR PRODUCTION** | Canonical | Immutable database migration chain required for fresh environment deployment and schema verification. | HIGH | **KEEP (PROTECTED)** |
| `POST /v1/pm/users` (in `userManagement.ts`) | **F. LEGACY / COMPATIBILITY** | API Contract | Deprecated endpoint returning HTTP 410 GONE to inform legacy API consumers of `POST /v1/pm/users/invite`. | HIGH | **KEEP (PROTECTED)** |
| `POST /v1/test/reset-tracker-rate-limit` | **C. REQUIRED FOR TESTING** | Test Suite | Guarded with `if (process.env.NODE_ENV !== 'production')` to allow automated test resets without exposing endpoint in production. | HIGH | **KEEP (PROTECTED)** |
| Standalone Forensic Integration Test Suites (35 files) | **C. REQUIRED FOR TESTING** | Forensic Suites | Provides deep resilience, adversarial security, concurrency race, and audit integrity verification. | HIGH | **KEEP (PROTECTED)** |
| Playwright E2E Test Suites (8 files) | **C. REQUIRED FOR TESTING** | E2E Framework | Complete browser verification for desktop & mobile viewports. | HIGH | **KEEP (PROTECTED)** |

---

## 2. Docker & Container Exclusion Candidates

- Add root `.dockerignore` to strictly prevent `tests/`, `playwright-report/`, `test-results/`, `.pgdata/`, `.env`, and development logs from entering production container images without deleting them from source control.
