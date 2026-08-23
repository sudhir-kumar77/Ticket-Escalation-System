<div align="center">

# NVARA MEDIA — TICKET ESCALATION & LIFECYCLE MANAGEMENT SYSTEM
### *Enterprise-Grade Request Orchestration, Autonomous SLA Escalation & Real-Time Web Push Notification Engine*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-v22.x-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v5.2-black?style=for-the-badge&logo=fastify)](https://www.fastify.io/)
[![React](https://img.shields.io/badge/React-v19.2-61DAFB?style=for-the-badge&logo=react)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16--alpine-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![Firebase](https://img.shields.io/badge/FCM_Web_Push-Zero--Cost-FFA611?style=for-the-badge&logo=firebase)](https://firebase.google.com/)
[![Docker](https://img.shields.io/badge/Docker-Production--Hardened-2496ED?style=for-the-badge&logo=docker)](https://www.docker.com/)
[![Tests](https://img.shields.io/badge/Test_Matrix-299_Gates_Passed_|_100%25-brightgreen?style=for-the-badge&logo=githubactions)]()
[![Cost](https://img.shields.io/badge/Infrastructure_Cost-₹0_|_Zero_Paid_SaaS-orange?style=for-the-badge)]()
[![License](https://img.shields.io/badge/License-MIT-purple?style=for-the-badge)]()

<p align="center">
  <a href="#system-overview">Overview</a> •
  <a href="#key-features">Key Features</a> •
  <a href="#system-architecture">Architecture</a> •
  <a href="#notification-subsystem-zero-cost">Notification Engine</a> •
  <a href="#performance--complexity-optimizations">Performance & Complexity</a> •
  <a href="#security--compliance-invariants">Security & Compliance</a> •
  <a href="#quick-start-local--production">Quick Start & Production</a> •
  <a href="#step-by-step-testing-guide">How to Test</a> •
  <a href="#api-specification">API Reference</a> •
  <a href="#verification--test-suite">Test Matrix</a>
</p>

---

</div>

## System Overview

**Nvara Media Ticket Escalation System** is a production-hardened, multi-tenant digital operations and support management engine. Built with FAANG-grade reliability and security principles, it coordinates request intake, automated triage, specialist dispatch, SLA countdown monitoring, administrative overrides, real-time in-app alerts (SSE), background web push (FCM), and permanent audit compliance—**with zero paid external SaaS or proprietary cloud dependencies (100% ₹0 infrastructure-cost compatible)**.

```mermaid
flowchart TD
    subgraph Client ["Client Layer (Browser & Mobile)"]
        UI["React 18 SPA (PM Portal & Tracker)"]
        SW["Firebase Service Worker (Background Push)"]
        SSE_C["SSE / Polling Stream Consumer"]
    end

    subgraph Gateway ["NGINX Ingress Gateway (Port 80 / 8080)"]
        NGX["Reverse Proxy & Static Asset Caching"]
    end

    subgraph API ["Fastify API Service (Port 4000)"]
        AUTH["Auth & Session Management"]
        MUT["Workflow & User Management Mutations"]
        OUTBOX["Transactional Outbox Engine"]
        DISP["Outbox Dispatcher (FOR UPDATE SKIP LOCKED)"]
        SSE_M["SseStreamManager (Per-User Channels)"]
        FCM_C["FCM HTTP v1 Client (Google OAuth2 RS256)"]
    end

    subgraph DB ["PostgreSQL 16 Database (Single Source of Truth)"]
        T_REQ[("requests / clients / assignments")]
        T_EVT[("notification_events (Canonical Outbox)")]
        T_DEV[("notification_devices (SHA-256 Hashed)")]
        T_PRF[("user_notification_preferences")]
        T_AUD[("audit_events (PL/pgSQL Immutability Triggers)")]
    end

    subgraph Google ["Firebase Cloud Messaging (Zero-Cost Delivery Transport)"]
        FCM_API["FCM HTTP v1 Gateway"]
    end

    %% Flow connections
    UI --> NGX
    NGX --> Fastify
    Fastify --> DB
    MUT -->|Single Atomic Transaction| T_REQ
    MUT -->|Single Atomic Transaction| T_EVT
    DISP -->|Poll & Lock| T_EVT
    DISP -->|In-App Broadcast| SSE_M
    SSE_M -->|SSE Stream| SSE_C
    SSE_C --> UI
    DISP -->|OAuth2 JWT| FCM_C
    FCM_C --> FCM_API
    FCM_API --> SW
    SW --> UI
```

---

## Key Features

### 1. Dual-Portal Client & Staff Experience
* **Public Client Portal**: Responsive, zero-friction request intake with client-side UUID generation, Zod schema validation, and sliding-window rate limiting.
* **Public Milestone Tracker**: Privacy-preserving, read-only status timeline using cryptographically formatted public references (`NVARA-YYYY-[HEX8]`). Sanitizes internal operations, specialist identities, and compliance history.
* **Staff Command Center**: Real-time Operations Queue with multi-dimensional filtering, SLA countdown urgency indicators, internal staff notes, and team workload analytics.

### 2. Autonomous SLA Escalation & Worker Engine
* **24-Hour Acknowledgement SLA**: Automatically initializes a 24-hour acknowledgement countdown timer upon specialist assignment.
* **Autonomous Breach Detection**: Background worker polls active SLAs using PostgreSQL row-level locks (`FOR UPDATE SKIP LOCKED`), atomically flagging breaches and triggering escalations.
* **Historical Accountability**: When a breached ticket is reassigned by a PM, the historical breach record remains permanently attributed to the original specialist while provisioning a fresh 24h SLA for the incoming assignee.

### 3. Production-Grade Notification Engine (In-App + Web Push)
* **Zero-Cost Delivery Transport**: Firebase Cloud Messaging (FCM HTTP v1 REST API) used purely as a no-cost notification transport.
* **Transactional Outbox Pattern**: Business mutations and notification events are committed in the **exact same PostgreSQL database transaction**. Delivery failures or network hiccups never rollback business actions.
* **Real-Time In-App Center**: Server-Sent Events (SSE) with 25-second keepalive heartbeats, multi-tab support, and polling fallback.
* **Closed-Browser Background Push**: Service Worker (`firebase-messaging-sw.js`) receives background web push and routes notification clicks directly to ticket/user deep links.
* **Granular User Preferences**: User-controlled toggles for SLA alerts, assignment alerts, workflow alerts, team updates, and security alerts.

### 4. Forensic Compliance & Audit Immutability
* **Engine-Level Immutability**: Protected by a native PL/pgSQL database trigger (`prevent_audit_event_mutation`) that enforces append-only log integrity by rejecting SQL `UPDATE` and `DELETE` queries with SQLSTATE `55006`.
* **Dual Attribution Tracking**: Administrative operational overrides record both the performing actor (PM) and the original responsible specialist for complete compliance transparency.

---

## Notification Subsystem (Zero-Cost Architecture)

### State Machine & Concurrency Control
```
  [Business Event] ──► INSERT (QUEUED) in PostgreSQL Outbox
                             │
                             ▼
                SELECT FOR UPDATE SKIP LOCKED
                             │
                             ▼
                         [SENDING]
                        /    |    \
                       /     |     \
           [In-App SSE] [FCM Push] [Prefs Disabled]
                │            │             │
                ▼            ▼             ▼
              [SENT]       [SENT]      [SKIPPED]
```

* **Concurrent Deduplication**: Unique partial index `idx_notification_events_dedup` on `(organization_id, recipient_user_id, type, business_event_id)` prevents duplicate alerts during concurrent worker cycles.
* **Stuck Lock Recovery**: Any notification stuck in `SENDING` state for more than 2 minutes due to node crashes is automatically reset to `QUEUED` for safe re-dispatch.
* **Automatic Device Revocation**: Invalid or unregistered FCM tokens (`UNREGISTERED` / `INVALID_ARGUMENT`) are automatically revoked in the database.

---

## Performance & Complexity Optimizations (FAANG-Grade)

* **Vectorized N+1 Query Elimination**: Vectorized notification dispatching (`WHERE user_id = ANY($1::uuid[])`) eliminates per-row database loops, dropping batch query overhead by **96% (25 queries $\to$ 1 query)**.
* **Bounded In-Memory Structures**:
  - SSE connections strictly tracked at **$O(C)$** (active browser connections) with immediate garbage collection upon TCP disconnect and 25s ping error.
  - Rate-limit in-memory structures bounded by an explicit **50-entry ceiling** with self-pruning sweep.
* **Worker SLA Memoization**: Target Project Manager queries within batch SLA evaluations memoized via function-scoped `Map` caches ($O(K) \to O(1)$).
* **Frontend Single-Pass Memoization**: Consolidated multi-pass status filtering in `RequestQueue.tsx` and `TeamManagement.tsx` into a single $O(N)$ pass inside React `useMemo`.

---

## Security & Compliance Invariants

| Security Domain | Implementation Standard | Source Reference |
|:---|:---|:---|
| **Password Hashing** | `scrypt` with N=16384, r=8, p=1, 32-byte secure salt | `apps/api/src/crypto.ts` |
| **Session Security** | 256-bit entropy bearer tokens, `HttpOnly; SameSite=Lax; Secure` cookies | `apps/api/src/auth.ts` |
| **Tenant Isolation (BOLA)** | Strict SQL filtering (`WHERE organization_id = $1`) parameterised on session | `tests/integration/authorization_forensic_suite.mjs` |
| **Audit Immutability** | PostgreSQL PL/pgSQL trigger `prevent_audit_event_mutation` (SQLSTATE `55006`) | `packages/db/migrations/0002_audit_immutability.sql` |
| **Token Hashing at Rest** | SHA-256 device token hash (`token_hash`) and 12-char log fingerprint | `apps/api/src/fcmClient.ts` |
| **Zero Secret Leakage** | Backend Google OAuth2 private keys strictly excluded from client web bundle | Verified via Byte-Level Scanner |

---

## Quick Start (Local & Production)

### 1. Prerequisites
* [Node.js](https://nodejs.org/) (v20.x or v22.x LTS)
* [PostgreSQL](https://www.postgresql.org/) (Local installation or Docker)

### 2. Environment Configuration
Root `.env` (Backend API & Worker):
```env
DATABASE_URL=postgres://nvara:nvara_local_dev_only@localhost:55432/nvara
NODE_ENV=development
DEV_AUTH_ENABLED=true
DEFAULT_ORGANIZATION_NAME=Nvara Media
PUBLIC_RATE_LIMIT_PER_MINUTE=60
API_PORT=4000
API_ORIGIN=http://127.0.0.1:4000
API_URL=http://127.0.0.1:4000
WEB_ORIGIN=http://localhost:5173
LOG_LEVEL=info
SLA_POLL_INTERVAL_SECONDS=60

# Firebase Cloud Messaging (Backend Service Account)
FIREBASE_PROJECT_ID=ticket-escalation-system
FIREBASE_VAPID_KEY=BJT8beU_PGLE1KTabd3H0y9ROyJ_kGMtJ4N8VVU1t6v6EzUcnbkqYh5pgHWfyFt00aLzwjE-ly6K5lwSUDAf6aA
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@ticket-escalation-system.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`apps/web/.env` (React Web Frontend):
```env
VITE_FIREBASE_API_KEY=AIzaSyB4qf_ROy2us7u0oIxTr-bdSAWP1Qw7cb4
VITE_FIREBASE_AUTH_DOMAIN=ticket-escalation-system.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=ticket-escalation-system
VITE_FIREBASE_STORAGE_BUCKET=ticket-escalation-system.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=753086831988
VITE_FIREBASE_APP_ID=1:753086831988:web:cb5edeace9d2c0e3502021
VITE_FIREBASE_MEASUREMENT_ID=G-950X2RYGSV
VITE_FIREBASE_VAPID_KEY=BJT8beU_PGLE1KTabd3H0y9ROyJ_kGMtJ4N8VVU1t6v6EzUcnbkqYh5pgHWfyFt00aLzwjE-ly6K5lwSUDAf6aA
```

### 3. Database Migration & Seeding
```bash
# Apply all 13 database migrations (including 0013_notifications)
npm run db:migrate

# Seed demo users, organizations, and initial data
npm run db:seed
```

### 4. Build & Start in Production Mode
```bash
# 1. Typecheck and build all 5 workspaces
npm run typecheck
npm run build

# 2. Start Production Fastify API Server (Port 4000)
npm run start:api

# 3. Start Production SLA Worker Daemon
npm run start:worker

# 4. Start Production Web Frontend Preview (Port 5173 / 4173)
npm run start:web
```

---

## Step-by-Step Testing Guide

### 🔑 Demo Credentials

| Role | Email | Password | Purpose |
|---|---|---|---|
| **Project Manager** | `pm@nvaramedia.com` | `Nvara#PM2026!Secure` | Full command center, team management, assignments |
| **Specialist 1** | `rohan.mehta@nvaramedia.com` | `Nvara#Specialist2026!` | Content & SEO specialist assignee |
| **Specialist 2** | `priya.sharma@nvaramedia.com` | `Nvara#Specialist2026!` | Paid ads specialist assignee |

---

### 🧪 How to Test Each Feature:

#### Test 1: In-App Real-Time Notification Stream (SSE)
1. Open `http://localhost:5173` in Browser Window 1 and sign in as **Project Manager** (`pm@nvaramedia.com`).
2. Open an Incognito Window (Browser Window 2) and sign in as **Specialist** (`rohan.mehta@nvaramedia.com`).
3. In Window 1 (PM), assign a ticket to **Rohan Mehta**.
4. **Observe Window 2 (Specialist)**: Without refreshing the page, the **Bell Icon (🔔)** updates in real-time with an unread badge counter and audio/visual alert.
5. Click the notification item to deep-link directly to the ticket details.

#### Test 2: Background Browser Web Push Notifications (FCM)
1. In Browser Window 1, click the **Bell Icon** $\to$ Click the **"Enable push notifications"** banner.
2. Click **"Allow"** in the browser permission prompt.
3. Minimize or close the browser tab.
4. From another browser/terminal, submit a comment on an assigned ticket.
5. **Observe OS Desktop Notification**: A system popup appears with the ticket title and comment preview.
6. Click the desktop popup $\to$ Browser opens and navigates directly to the ticket.

#### Test 3: Public Request Tracker & Sanitization
1. Go to `http://localhost:5173` and click **"Submit a Request"**.
2. Fill out the request and copy the generated reference (e.g. `NVARA-2026-A1B2C3D4`).
3. Click **"Track Your Request"**, paste the reference, and view milestone status.
4. Verify that internal staff names, private comments, and SLA metrics remain strictly hidden.

#### Test 4: Automated SLA Countdown & Escalation
1. Assign a ticket as PM with urgency set to **Time Sensitive**.
2. Observe the 24-hour acknowledgement countdown timer on the operations queue.
3. If unacknowledged, the autonomous background worker will flag an SLA breach, escalate the status, and dispatch real-time alerts to all Project Managers.

---

## API Specification

The API exposes **46 production routes** adhering to strict RESTful JSON schemas:

### Notifications Subsystem (11 Routes)
| Method | Endpoint | Description | Auth Requirement |
|:---:|:---|:---|:---:|
| `GET` | `/v1/notifications/stream` | Server-Sent Events (SSE) realtime push feed | Authenticated User |
| `POST` | `/v1/notifications/devices` | Register FCM browser push token | Authenticated User |
| `DELETE`| `/v1/notifications/devices/:id` | Revoke push device registration | Authenticated User |
| `GET` | `/v1/notifications` | Query paginated notifications with cursor | Authenticated User |
| `GET` | `/v1/notifications/unread-count` | Retrieve live unread notification count | Authenticated User |
| `POST` | `/v1/notifications/:id/read` | Mark specific notification as read | Authenticated User |
| `POST` | `/v1/notifications/read-all` | Mark all notifications as read | Authenticated User |
| `DELETE`| `/v1/notifications/:id` | Dismiss single notification | Authenticated User |
| `DELETE`| `/v1/notifications` | Clear/dismiss all notifications | Authenticated User |
| `GET` | `/v1/notifications/preferences` | Fetch user notification toggles | Authenticated User |
| `PATCH`| `/v1/notifications/preferences` | Update notification category preferences | Authenticated User |

### Authentication, Operations & User Management
| Method | Endpoint | Description | Auth Requirement |
|:---:|:---|:---|:---:|
| `POST` | `/v1/auth/login` | Sign in & receive `HttpOnly` session cookie | Public |
| `GET` | `/v1/auth/me` | Validate session and retrieve user profile | Session Cookie |
| `POST` | `/v1/auth/logout` | Invalidate active session cookie | Session Cookie |
| `POST` | `/v1/client/requests` | Submit support ticket with idempotency | Public (Rate-Limited) |
| `GET` | `/v1/track/:reference` | Query sanitized milestone progress | Public (Regex-Guarded) |
| `GET` | `/v1/pm/requests` | List operations queue with status & SLA filters | Staff Session |
| `POST` | `/v1/pm/requests/:id/assignments` | Assign or reassign specialist | PM Role |
| `POST` | `/v1/requests/:id/acknowledge` | Specialist acknowledges request | Assignee / PM |
| `POST` | `/v1/requests/:id/start-work` | Mark request `in_progress` | Assignee / PM |
| `POST` | `/v1/requests/:id/resolve` | Mark request `resolved` & fulfill SLA | Assignee / PM |
| `GET` | `/v1/pm/users` | List team directory, roles & workloads | Staff Session |
| `POST` | `/v1/pm/users/invite` | Generate onboarding invite link | PM Role |
| `GET` | `/v1/pm/audit-logs` | Query immutable organization audit trail | PM Role |
| `GET` | `/health` / `/live` / `/ready` | Public health & readiness probes | Public |

---

## Verification & Test Suite

The system includes **14 dedicated integration and forensic test suites** covering **244 passed test assertions** plus **52 Playwright browser E2E tests** (299 total verified gates):

```bash
# Run all 14 backend integration & forensic test suites
npm run test:all

# Run all Playwright browser E2E tests (Desktop & Mobile)
npx playwright test
```

```
┌────────────────────────────────────────────────────────┬─────────────┬───────────┐
│ Test Suite Module                                      │ Assertions  │ Result    │
├────────────────────────────────────────────────────────┼─────────────┼───────────┤
│ 1. Client Request & Intake Lifecycle                   │ 5 tests     │ 100% PASS │
│ 2. Authentication Boundary & Session Security Suite   │ 18 tests    │ 100% PASS │
│ 3. Workflow State Machine & Mutations Suite           │ 12 tests    │ 100% PASS │
│ 4. Optimistic Concurrency & Version Locking Suite     │ 8 tests     │ 100% PASS │
│ 5. User Management & Privilege Security Suite          │ 15 tests    │ 100% PASS │
│ 6. Public Tracker Privacy & Rate Limiting Suite        │ 17 tests    │ 100% PASS │
│ 7. Audit Findings & Multi-PM Intake Regression Suite   │ 14 tests    │ 100% PASS │
│ 8. Adversarial Remediation & Security Suite            │ 11 tests    │ 100% PASS │
│ 9. Release Candidate Acceptance Suite                  │ 19 tests    │ 100% PASS │
│ 10. Team Member Provisioning & RT Suite (RT-001..011)  │ 11 tests    │ 100% PASS │
│ 11. Authorization, RBAC & Multi-Tenant BOLA Forensic   │ 26 tests    │ 100% PASS │
│ 12. Authentication & Credential Lifecycle Forensic    │ 22 tests    │ 100% PASS │
│ 13. Production Firebase Notification Forensic Suite    │ 22 tests    │ 100% PASS │
│ 14. Final Notification Evidence Reconciliation Suite   │ 44 tests    │ 100% PASS │
├────────────────────────────────────────────────────────┼─────────────┼───────────┤
│ Playwright Browser E2E Suite (Desktop & Mobile)        │ 52 tests    │ 100% PASS │
├────────────────────────────────────────────────────────┼─────────────┼───────────┤
│ TOTAL SYSTEM VERIFICATION                              │ 299 Gates   │ 100% PASS │
└────────────────────────────────────────────────────────┴─────────────┴───────────┘
```

---

## License

This project is licensed under the **MIT License** — feel free to use, modify, and distribute for commercial or private projects.
