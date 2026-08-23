import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const api = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000'
const pmHeaders = { 'X-Dev-Auth-Subject': 'dev-pm-subject-001' }
const internalHeaders = { 'X-Dev-Auth-Subject': 'dev-internal-subject-001' }

async function loginAsPm(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /operations workspace/i }).click()
  await page.getByLabel('Work Email').fill('pm@nvaramedia.com')
  await page.locator('input#password').fill('Nvara#PM2026!Secure')
  await Promise.all([
    page.waitForResponse((res) => res.url().includes('/v1/auth/login') && res.status() === 200),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
  await page.waitForTimeout(400)
}

test.describe('Notification System E2E Suite', () => {
  test('Service Worker script is accessible with correct MIME type', async ({ page }) => {
    const response = await page.goto('/firebase-messaging-sw.js')
    expect(response?.status()).toBe(200)
    const text = await response?.text()
    expect(text).toContain('firebase-messaging-compat.js')
    expect(text).toContain('onBackgroundMessage')
    expect(text).toContain('notificationclick')
  })

  test('Notification bell, center popover, read state and preferences flow', async ({ page, request }) => {
    // 1. Create a ticket and trigger a notification via workflow mutation
    const uid = randomUUID()
    const createRes = await request.post(`${api}/v1/client/requests`, {
      headers: { ...pmHeaders, 'Idempotency-Key': `e2e-notif-${uid}`, 'Content-Type': 'application/json' },
      data: {
        name: 'Notification E2E Tester',
        company: 'Nvara Quality Labs',
        email: `tester-${uid}@example.test`,
        phone: '+919876543210',
        serviceDomain: 'seo',
        requirement: 'Verifying notification center popover and real-time alerts.',
        urgency: 'time_sensitive',
      },
    })
    expect(createRes.status()).toBe(201)
    const publicRef = (await createRes.json()).reference

    // Get team member ID
    const membersRes = await request.get(`${api}/v1/pm/team-members`, { headers: pmHeaders })
    const memberList = (await membersRes.json()).teamMembers
    const specialist = memberList.find((m: any) => m.email === 'rohan.mehta@nvaramedia.com') ?? memberList[0]

    // Read current version
    const reqRes = await request.get(`${api}/v1/pm/requests/${publicRef}`, { headers: pmHeaders })
    const currentVersion = (await reqRes.json()).request.version

    // Assign request -> triggers REQUEST_ASSIGNED
    const assignRes = await request.post(`${api}/v1/pm/requests/${publicRef}/assignments`, {
      headers: { ...pmHeaders, 'Idempotency-Key': `assign-${randomUUID()}`, 'Content-Type': 'application/json' },
      data: { assigneeUserId: specialist.id, expectedVersion: currentVersion },
    })
    expect(assignRes.status()).toBe(200)

    // Acknowledge -> triggers REQUEST_ACKNOWLEDGED for PM
    const ackRes = await request.post(`${api}/v1/requests/${publicRef}/acknowledge`, {
      headers: { ...internalHeaders, 'Idempotency-Key': `ack-${randomUUID()}`, 'Content-Type': 'application/json' },
      data: { expectedVersion: currentVersion + 1 },
    })
    expect(ackRes.status()).toBe(200)

    // 2. Open PM portal in browser with authenticated session
    await loginAsPm(page)

    // 3. Verify Notification Bell is visible in header
    const bell = page.locator('[data-testid="notification-bell"]')
    await expect(bell).toBeVisible({ timeout: 10000 })

    // 4. Click Notification Bell to open dropdown
    await bell.click()
    const dropdown = page.locator('[data-testid="notification-center-dropdown"]')
    await expect(dropdown).toBeVisible()

    // 5. Verify filter tabs exist and work
    const tabAll = page.locator('[data-testid="tab-all"]')
    const tabUnread = page.locator('[data-testid="tab-unread"]')
    await expect(tabAll).toBeVisible()
    await expect(tabUnread).toBeVisible()

    // 6. Verify notification items appear
    const notifItems = page.locator('[data-testid="notification-item"]')
    const count = await notifItems.count()
    expect(count).toBeGreaterThan(0)

    // 7. Verify Preferences toggle modal
    const prefsBtn = page.locator('[data-testid="notification-preferences-btn"]')
    await expect(prefsBtn).toBeVisible()
    await prefsBtn.click()

    await expect(page.getByText('Notification Preferences')).toBeVisible()
    await expect(page.getByText('Browser Push Notifications')).toBeVisible()
    await expect(page.getByText('SLA & Escalation Alerts')).toBeVisible()

    // Close preferences
    await page.getByRole('button', { name: 'Done' }).click()

    // 8. Test Mark All as Read button if present
    const markAllBtn = page.locator('[data-testid="mark-all-read-btn"]')
    if (await markAllBtn.isVisible()) {
      await markAllBtn.click()
      // Unread badge should disappear or show 0
      const unreadBadge = page.locator('[data-testid="unread-badge"]')
      await expect(unreadBadge).not.toBeVisible()
    }

    // 9. Test Clear all button
    const clearAllBtn = page.locator('[data-testid="clear-all-btn"]')
    if (await clearAllBtn.isVisible()) {
      await clearAllBtn.click()
      await expect(page.getByText('No notifications yet')).toBeVisible()
    }

    // 10. Press Escape to close dropdown
    await page.keyboard.press('Escape')
    await expect(dropdown).not.toBeVisible()
  })
})
