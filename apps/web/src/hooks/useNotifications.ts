import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AppNotification,
  type NotificationPreferences,
  deleteNotification,
  clearAllNotifications,
  getNotificationPreferences,
  getUnreadCount,
  listNotifications,
  markAllNotificationsAsRead,
  markNotificationAsRead,
  registerDeviceToken,
  subscribeToNotificationStream,
  updateNotificationPreferences,
} from '../services/notificationApi';
import {
  requestNotificationPermissionAndGetToken,
  subscribeForegroundMessage,
} from '../services/firebaseClient';

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission;
    }
    return 'default';
  });
  const [pushRegistered, setPushRegistered] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      return Notification.permission === 'granted';
    }
    return false;
  });
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'unread'>('all');
  const [lastReceivedNotification, setLastReceivedNotification] = useState<AppNotification | null>(null);

  const isMountedRef = useRef(true);

  // Sync browser notification permission state
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const currentPerm = Notification.permission;
      setPermission(currentPerm);
      if (currentPerm === 'granted') {
        setPushRegistered(true);
      }
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listNotifications({ limit: 50 });
      if (isMountedRef.current) {
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load notifications.');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const loadPreferences = useCallback(async () => {
    try {
      const prefs = await getNotificationPreferences();
      if (isMountedRef.current) {
        setPreferences(prefs);
      }
    } catch {
      // Gracefully ignore preferences fetch error
    }
  }, []);

  // Handle Mark as Read
  const handleMarkAsRead = useCallback(async (id: string) => {
    // Optimistic UI update
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n))
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));

    try {
      const result = await markNotificationAsRead(id);
      if (isMountedRef.current && typeof result.unreadCount === 'number') {
        setUnreadCount(result.unreadCount);
      }
    } catch (err) {
      console.warn('Failed to mark notification as read on server:', err);
      // Reconcile on failure
      void loadNotifications();
    }
  }, [loadNotifications]);

  // Handle Mark All as Read
  const handleMarkAllAsRead = useCallback(async () => {
    // Optimistic UI update
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() }))
    );
    setUnreadCount(0);

    try {
      await markAllNotificationsAsRead();
    } catch (err) {
      console.warn('Failed to mark all notifications as read on server:', err);
      void loadNotifications();
    }
  }, [loadNotifications]);

  // Handle Delete / Dismiss Single Notification (Referentially stable)
  const handleDeleteNotification = useCallback(async (id: string) => {
    // Optimistic UI update
    setNotifications((prev) => {
      const target = prev.find((n) => n.id === id);
      if (target && !target.readAt) {
        setUnreadCount((u) => Math.max(0, u - 1));
      }
      return prev.filter((n) => n.id !== id);
    });

    try {
      const res = await deleteNotification(id);
      if (isMountedRef.current && typeof res.unreadCount === 'number') {
        setUnreadCount(res.unreadCount);
      }
    } catch (err) {
      console.warn('Failed to delete notification on server:', err);
      void loadNotifications();
    }
  }, [loadNotifications]);

  // Handle Clear All Notifications
  const handleClearAllNotifications = useCallback(async () => {
    // Optimistic UI update
    setNotifications([]);
    setUnreadCount(0);

    try {
      await clearAllNotifications();
    } catch (err) {
      console.warn('Failed to clear all notifications on server:', err);
      void loadNotifications();
    }
  }, [loadNotifications]);

  // Handle Request Permission & Register FCM Push Token
  const handleEnablePush = useCallback(async () => {
    try {
      const { token, permission: resPermission } = await requestNotificationPermissionAndGetToken();
      if (isMountedRef.current) {
        setPermission(resPermission);
        if (resPermission === 'granted') {
          setPushRegistered(true);
        }
      }
      if (token) {
        await registerDeviceToken({
          fcmToken: token,
          browser: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 100) : 'Browser',
          deviceLabel: 'Web Push Device',
        });
      }
    } catch (err) {
      console.warn('Failed to register browser push notification device:', err);
    }
  }, []);

  // Handle Save Preferences
  const handleSavePreferences = useCallback(async (newPrefs: Partial<NotificationPreferences>) => {
    try {
      const saved = await updateNotificationPreferences(newPrefs);
      if (isMountedRef.current) {
        setPreferences(saved);
      }
      return saved;
    } catch (err) {
      console.error('Failed to update notification preferences:', err);
      throw err;
    }
  }, []);

  // Setup Initial Mount, SSE Stream, and Foreground Push Listener
  useEffect(() => {
    isMountedRef.current = true;
    void loadNotifications();
    void loadPreferences();

    // 1. Subscribe to SSE Stream
    const unsubscribeStream = subscribeToNotificationStream({
      onNotification: (notif) => {
        if (!isMountedRef.current) return;
        setNotifications((prev) => {
          const exists = prev.some((n) => n.id === notif.id);
          if (exists) return prev;
          return [notif, ...prev];
        });
        setUnreadCount((prev) => prev + 1);
        setLastReceivedNotification(notif);
      },
      onUnreadCount: (count) => {
        if (!isMountedRef.current) return;
        setUnreadCount(count);
      },
      onConnect: () => {
        // Reconcile unread count and notifications on reconnect
        getUnreadCount().then((count) => {
          if (isMountedRef.current) setUnreadCount(count);
        }).catch(() => {});
      },
    });

    // 2. Subscribe to Foreground FCM Messages
    const unsubscribeFcm = subscribeForegroundMessage((payload) => {
      if (!isMountedRef.current) return;
      console.log('Received foreground FCM message:', payload);
      void loadNotifications();
    });

    // 3. Periodic reconciliation polling fallback (every 30 seconds)
    const pollInterval = setInterval(() => {
      getUnreadCount()
        .then((count) => {
          if (isMountedRef.current) setUnreadCount(count);
        })
        .catch(() => {});
    }, 30000);

    return () => {
      isMountedRef.current = false;
      unsubscribeStream();
      unsubscribeFcm();
      clearInterval(pollInterval);
    };
  }, [loadNotifications, loadPreferences]);

  return {
    notifications,
    unreadCount,
    loading,
    error,
    permission,
    pushRegistered,
    preferences,
    activeTab,
    lastReceivedNotification,
    setActiveTab,
    refresh: loadNotifications,
    markAsRead: handleMarkAsRead,
    markAllAsRead: handleMarkAllAsRead,
    deleteNotification: handleDeleteNotification,
    clearAll: handleClearAllNotifications,
    enablePush: handleEnablePush,
    savePreferences: handleSavePreferences,
  };
}
