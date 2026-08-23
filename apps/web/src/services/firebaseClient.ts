import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, type Messaging, type MessagePayload } from 'firebase/messaging';

export interface FirebaseClientConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  vapidKey?: string;
}

export function getClientFirebaseConfig(): FirebaseClientConfig {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
  };
}

let firebaseApp: FirebaseApp | null = null;
let messagingInstance: Messaging | null = null;

export function getFirebaseMessaging(): Messaging | null {
  if (messagingInstance) return messagingInstance;
  if (typeof window === 'undefined') return null;

  const config = getClientFirebaseConfig();
  if (!config.projectId || !config.apiKey) {
    return null;
  }

  try {
    if (!getApps().length) {
      firebaseApp = initializeApp(config);
    } else {
      firebaseApp = getApps()[0];
    }
    messagingInstance = getMessaging(firebaseApp);
    return messagingInstance;
  } catch (err) {
    console.warn('[FirebaseClient] Unable to initialize Firebase Messaging in this browser context:', err);
    return null;
  }
}

export async function requestNotificationPermissionAndGetToken(): Promise<{
  token: string | null;
  permission: NotificationPermission;
}> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return { token: null, permission: 'denied' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { token: null, permission };
  }

  const messaging = getFirebaseMessaging();
  const config = getClientFirebaseConfig();

  if (!messaging) {
    console.info('[FirebaseClient] Push notifications permission granted. Firebase credentials not configured in frontend env; fallback in-app active.');
    return { token: null, permission };
  }

  try {
    let swReg: ServiceWorkerRegistration | undefined;
    if ('serviceWorker' in navigator) {
      const swUrl = `/firebase-messaging-sw.js?projectId=${encodeURIComponent(config.projectId || '')}&apiKey=${encodeURIComponent(config.apiKey || '')}&messagingSenderId=${encodeURIComponent(config.messagingSenderId || '')}&appId=${encodeURIComponent(config.appId || '')}`;
      swReg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
      await navigator.serviceWorker.ready;
    }

    const token = await getToken(messaging, {
      vapidKey: config.vapidKey,
      serviceWorkerRegistration: swReg,
    });

    return { token, permission };
  } catch (err) {
    console.warn('[FirebaseClient] Error retrieving FCM token:', err);
    return { token: null, permission };
  }
}

export function subscribeForegroundMessage(
  onPayload: (payload: MessagePayload) => void
): () => void {
  const messaging = getFirebaseMessaging();
  if (!messaging) return () => {};

  return onMessage(messaging, (payload) => {
    onPayload(payload);
  });
}
