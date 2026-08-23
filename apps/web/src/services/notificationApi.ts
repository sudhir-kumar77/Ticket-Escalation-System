import { getAuthHeaders } from './devAuth';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  requestId: string | null;
  assignmentId: string | null;
  auditEventId: string | null;
  metadata: Record<string, any>;
  category: 'sla' | 'assignment' | 'workflow' | 'team' | 'security';
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferences {
  browserPushEnabled: boolean;
  slaAlerts: boolean;
  assignmentAlerts: boolean;
  workflowAlerts: boolean;
  teamAlerts: boolean;
  securityAlerts: boolean;
  updatedAt?: string;
}

const headers = (): Record<string, string> => ({
  ...getAuthHeaders(),
  'Content-Type': 'application/json',
});

export async function listNotifications(params?: {
  limit?: number;
  before?: string;
  unreadOnly?: boolean;
}): Promise<{ notifications: AppNotification[]; unreadCount: number; hasMore: boolean }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.before) query.set('before', params.before);
  if (params?.unreadOnly) query.set('unreadOnly', 'true');

  const response = await fetch(`/v1/notifications?${query.toString()}`, {
    method: 'GET',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to fetch notifications.');
  }

  return response.json();
}

export async function getUnreadCount(): Promise<number> {
  const response = await fetch('/v1/notifications/unread-count', {
    method: 'GET',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to fetch unread count.');
  }

  const data = await response.json();
  return data.unreadCount ?? 0;
}

export async function markNotificationAsRead(id: string): Promise<{ success: boolean; unreadCount: number }> {
  const response = await fetch(`/v1/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to mark notification as read.');
  }

  return response.json();
}

export async function markAllNotificationsAsRead(): Promise<{ success: boolean; markedCount: number; unreadCount: number }> {
  const response = await fetch('/v1/notifications/read-all', {
    method: 'POST',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to mark all notifications as read.');
  }

  return response.json();
}

export async function deleteNotification(id: string): Promise<{ success: boolean; deletedId: string; unreadCount: number }> {
  const response = await fetch(`/v1/notifications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to delete notification.');
  }

  return response.json();
}

export async function clearAllNotifications(): Promise<{ success: boolean; clearedCount: number; unreadCount: number }> {
  const response = await fetch('/v1/notifications', {
    method: 'DELETE',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to clear all notifications.');
  }

  return response.json();
}

export async function registerDeviceToken(payload: {
  fcmToken: string;
  browser?: string;
  deviceLabel?: string;
}): Promise<{ success: boolean; deviceId: string }> {
  const response = await fetch('/v1/notifications/devices', {
    method: 'POST',
    headers: headers(),
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to register device for push notifications.');
  }

  return response.json();
}

export async function revokeDeviceToken(deviceId: string): Promise<{ success: boolean }> {
  const response = await fetch(`/v1/notifications/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to revoke device token.');
  }

  return response.json();
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const response = await fetch('/v1/notifications/preferences', {
    method: 'GET',
    headers: headers(),
    credentials: 'include',
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to fetch notification preferences.');
  }

  const data = await response.json();
  return data.preferences;
}

export async function updateNotificationPreferences(
  preferences: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const response = await fetch('/v1/notifications/preferences', {
    method: 'PATCH',
    headers: headers(),
    credentials: 'include',
    body: JSON.stringify(preferences),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? 'Failed to update notification preferences.');
  }

  const data = await response.json();
  return data.preferences;
}

export function subscribeToNotificationStream(callbacks: {
  onNotification: (notification: AppNotification) => void;
  onUnreadCount: (count: number) => void;
  onConnect?: () => void;
  onError?: (err: any) => void;
}): () => void {
  const authHeaders = getAuthHeaders();
  const query = new URLSearchParams();
  if (authHeaders['x-dev-auth-subject']) {
    query.set('subject', authHeaders['x-dev-auth-subject']);
  }

  const url = `/v1/notifications/stream?${query.toString()}`;
  let eventSource: EventSource | null = null;
  let closed = false;

  try {
    eventSource = new EventSource(url, { withCredentials: true });

    eventSource.addEventListener('connected', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.unreadCount === 'number') {
          callbacks.onUnreadCount(data.unreadCount);
        }
        callbacks.onConnect?.();
      } catch {}
    });

    eventSource.addEventListener('notification', (e) => {
      try {
        const data = JSON.parse(e.data);
        callbacks.onNotification(data);
      } catch {}
    });

    eventSource.addEventListener('unread_count', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.unreadCount === 'number') {
          callbacks.onUnreadCount(data.unreadCount);
        }
      } catch {}
    });

    eventSource.onerror = (err) => {
      if (!closed) {
        callbacks.onError?.(err);
      }
    };
  } catch (err) {
    callbacks.onError?.(err);
  }

  return () => {
    closed = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
