/* Firebase Cloud Messaging Service Worker for Nvara Operations Platform */

// Give the service worker access to Firebase Messaging.
// Note that you can only use Firebase Messaging here. Other Firebase libraries are not available in the service worker.
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Initialize Firebase app in service worker if configuration is passed or default
const urlParams = new URL(location).searchParams;
const firebaseConfig = {
  apiKey: urlParams.get('apiKey') || undefined,
  authDomain: urlParams.get('authDomain') || undefined,
  projectId: urlParams.get('projectId') || undefined,
  storageBucket: urlParams.get('storageBucket') || undefined,
  messagingSenderId: urlParams.get('messagingSenderId') || undefined,
  appId: urlParams.get('appId') || undefined,
};

if (firebaseConfig.projectId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message: ', payload);

    const title = payload.notification?.title || payload.data?.title || 'Nvara Operations Alert';
    const notificationOptions = {
      body: payload.notification?.body || payload.data?.body || '',
      icon: payload.notification?.icon || '/favicon.ico',
      badge: '/favicon.ico',
      tag: payload.data?.notificationId || 'nvara-notification',
      data: {
        url: payload.data?.clickAction || payload.fcmOptions?.link || '/',
        notificationId: payload.data?.notificationId,
        requestId: payload.data?.requestId,
        type: payload.data?.type,
      },
    };

    return self.registration.showNotification(title, notificationOptions);
  });
}

// Fallback background push listener if native Web Push payload is delivered directly
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    if (data && (data.notification || data.data)) {
      const title = data.notification?.title || data.data?.title || 'Nvara Operations Alert';
      const options = {
        body: data.notification?.body || data.data?.body || '',
        icon: data.notification?.icon || '/favicon.ico',
        badge: '/favicon.ico',
        tag: data.data?.notificationId || 'nvara-notification',
        data: {
          url: data.data?.clickAction || data.fcmOptions?.link || '/',
          notificationId: data.data?.notificationId,
          requestId: data.data?.requestId,
          type: data.data?.type,
        },
      };
      event.waitUntil(self.registration.showNotification(title, options));
    }
  } catch (e) {
    // If not JSON text payload
    event.waitUntil(
      self.registration.showNotification('Nvara Operations Alert', {
        body: event.data.text(),
        icon: '/favicon.ico',
      })
    );
  }
});

// Notification click handler: focus existing window if already open, or open window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a tab is already open, focus it and post a message
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            data: event.notification.data,
          });
          return client.focus();
        }
      }
      // If no tab is open, open a new window with the target URL
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
