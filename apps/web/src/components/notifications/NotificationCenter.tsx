import React, { useEffect, useRef, useState } from 'react';
import type { AppNotification, NotificationPreferences } from '../../services/notificationApi';
import { useNotifications } from '../../hooks/useNotifications';

export interface NotificationCenterProps {
  onNavigateToRequest?: (requestId: string) => void;
  onNavigateToTeam?: () => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getCategoryStyles(category: AppNotification['category']) {
  switch (category) {
    case 'sla':
      return {
        bg: 'bg-amber-50 text-amber-700 border-amber-200',
        dot: 'bg-amber-500',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        ),
      };
    case 'assignment':
      return {
        bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        dot: 'bg-emerald-500',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <polyline points="17 11 19 13 23 9" />
          </svg>
        ),
      };
    case 'security':
      return {
        bg: 'bg-rose-50 text-rose-700 border-rose-200',
        dot: 'bg-rose-500',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        ),
      };
    case 'team':
      return {
        bg: 'bg-indigo-50 text-indigo-700 border-indigo-200',
        dot: 'bg-indigo-500',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      };
    case 'workflow':
    default:
      return {
        bg: 'bg-sky-50 text-sky-700 border-sky-200',
        dot: 'bg-sky-500',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        ),
      };
  }
}

export function NotificationCenter({ onNavigateToRequest, onNavigateToTeam }: NotificationCenterProps) {
  const {
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
    refresh,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    clearAll,
    enablePush,
    savePreferences,
  } = useNotifications();

  const [isOpen, setIsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [enablingPush, setEnablingPush] = useState(false);
  const [permissionBannerDismissed, setPermissionBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem('nvara_push_banner_dismissed') === 'true';
    } catch {
      return false;
    }
  });
  const [savingPrefs, setSavingPrefs] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setPreferencesOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Handle ESC key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && (isOpen || preferencesOpen)) {
        if (preferencesOpen) {
          setPreferencesOpen(false);
        } else {
          setIsOpen(false);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, preferencesOpen]);

  const unreadItems = notifications.filter((n) => !n.readAt);
  const effectiveUnreadCount = Math.max(unreadCount, unreadItems.length);

  const filteredNotifications = notifications.filter((n) => {
    if (activeTab === 'unread') return !n.readAt;
    return true;
  });

  const handleItemClick = (notification: AppNotification) => {
    if (!notification.readAt) {
      void markAsRead(notification.id);
    }
    setIsOpen(false);

    if (notification.requestId && onNavigateToRequest) {
      onNavigateToRequest(notification.requestId);
    } else if (notification.category === 'team' && onNavigateToTeam) {
      onNavigateToTeam();
    }
  };

  const handlePreferenceToggle = async (key: keyof NotificationPreferences) => {
    if (!preferences) return;
    setSavingPrefs(true);
    try {
      await savePreferences({
        [key]: !preferences[key],
      });
    } finally {
      setSavingPrefs(false);
    }
  };

  return (
    <div className="relative inline-block text-left" ref={containerRef}>
      {/* ── ARIA live announcement region for incoming notifications ── */}
      <div className="sr-only" aria-live="polite" role="status">
        {lastReceivedNotification ? `New notification: ${lastReceivedNotification.title}. ${lastReceivedNotification.body}` : ''}
      </div>

      {/* ── Notification Bell Trigger ── */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`relative flex items-center justify-center w-9 h-9 rounded-xl border transition-all duration-150 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1 ${
          isOpen
            ? 'bg-slate-100 border-slate-300 text-[#0f172a] ring-2 ring-emerald-500/20 shadow-inner'
            : 'bg-white border-slate-200/90 text-slate-700 hover:text-[#0f172a] hover:bg-slate-50 hover:border-slate-300 shadow-xs'
        }`}
        aria-label="Open notifications"
        aria-expanded={isOpen}
        aria-haspopup="true"
        data-testid="notification-bell"
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill={effectiveUnreadCount > 0 ? 'currentColor' : 'none'}
          className={effectiveUnreadCount > 0 ? 'text-amber-500 fill-amber-500/25' : 'text-slate-700'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {effectiveUnreadCount > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-mono font-bold text-white bg-rose-500 rounded-full border-2 border-white shadow-xs animate-in zoom-in-75 duration-200"
            data-testid="unread-badge"
          >
            {effectiveUnreadCount > 99 ? '99+' : effectiveUnreadCount}
          </span>
        )}
      </button>

      {/* ── Notification Center Dropdown / Drawer ── */}
      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-[360px] sm:w-[400px] max-w-[92vw] bg-white rounded-2xl shadow-2xl border border-[#e2e8f0] z-50 overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in-50 zoom-in-95 duration-150"
          data-testid="notification-center-dropdown"
          role="dialog"
          aria-label="Notifications Panel"
        >
          {/* Header */}
          <div className="px-4 py-3.5 border-b border-[#f1f5f9] flex items-center justify-between bg-[#fafbfc]">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-bold text-[#0f172a] tracking-tight">Notifications</h2>
              {unreadItems.length > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded-full">
                  {unreadItems.length} unread
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {unreadItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllAsRead()}
                  className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700 px-1.5 py-0.5 rounded hover:bg-emerald-50 transition-colors cursor-pointer"
                  data-testid="mark-all-read-btn"
                >
                  Mark all read
                </button>
              )}

              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearAll()}
                  className="text-[11px] font-semibold text-slate-400 hover:text-rose-600 px-1.5 py-0.5 rounded hover:bg-rose-50 transition-colors cursor-pointer"
                  title="Clear all notifications"
                  data-testid="clear-all-btn"
                >
                  Clear all
                </button>
              )}

              <button
                type="button"
                onClick={() => setPreferencesOpen((prev) => !prev)}
                className="p-1 text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9] rounded-lg transition-colors cursor-pointer"
                title="Notification Settings"
                aria-label="Notification Settings"
                data-testid="notification-preferences-btn"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Controlled Browser Push Permission Banner ── */}
          {permission !== 'granted' && !pushRegistered && !permissionBannerDismissed && (
            <div className="mx-3 my-2 p-3 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 rounded-xl flex items-start gap-2.5">
              <div className="p-1 rounded-lg bg-emerald-500 text-white flex-none mt-0.5">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-bold text-[#0f172a] leading-tight">Enable Browser Push Alerts</p>
                <p className="text-[11px] text-[#64748b] leading-tight mt-0.5">
                  Receive critical SLA breaches and assignment updates even when Nvara is closed.
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    disabled={enablingPush}
                    onClick={async () => {
                      setEnablingPush(true);
                      try {
                        await enablePush();
                        setPermissionBannerDismissed(true);
                        try {
                          localStorage.setItem('nvara_push_banner_dismissed', 'true');
                        } catch {}
                      } finally {
                        setEnablingPush(false);
                      }
                    }}
                    className="px-2.5 py-1 text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
                    data-testid="enable-push-btn"
                  >
                    {enablingPush ? (
                      <>
                        <svg className="animate-spin h-3 w-3 text-white" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span>Enabling...</span>
                      </>
                    ) : (
                      <span>Enable Notifications</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPermissionBannerDismissed(true);
                      try {
                        localStorage.setItem('nvara_push_banner_dismissed', 'true');
                      } catch {}
                    }}
                    className="text-[11px] text-[#64748b] hover:text-[#0f172a] px-1.5 py-0.5 rounded cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Preferences Sub-View ── */}
          {preferencesOpen ? (
            <div className="p-4 overflow-y-auto space-y-4 bg-white">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-bold text-[#0f172a]">Notification Preferences</h3>
                <button
                  type="button"
                  onClick={() => setPreferencesOpen(false)}
                  className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-700 cursor-pointer"
                >
                  Done
                </button>
              </div>

              {preferences ? (
                <div className="space-y-3 divide-y divide-slate-100">
                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">Browser Push Notifications</p>
                      <p className="text-[11px] text-[#64748b]">Receive push alerts when the web app is backgrounded</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.browserPushEnabled}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('browserPushEnabled')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">SLA & Escalation Alerts</p>
                      <p className="text-[11px] text-[#64748b]">Warning thresholds and breach notifications</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.slaAlerts}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('slaAlerts')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">Assignment Alerts</p>
                      <p className="text-[11px] text-[#64748b]">When tickets are assigned or reassigned to you</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.assignmentAlerts}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('assignmentAlerts')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">Workflow & Comments</p>
                      <p className="text-[11px] text-[#64748b]">Acknowledgements, work started, resolutions, comments</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.workflowAlerts}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('workflowAlerts')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">Team Lifecycle Alerts</p>
                      <p className="text-[11px] text-[#64748b]">Team invitations, onboarding, and status changes</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.teamAlerts}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('teamAlerts')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <div>
                      <p className="text-[12px] font-semibold text-[#0f172a]">Security Alerts</p>
                      <p className="text-[11px] text-[#64748b]">Password changes, remote session terminations</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={preferences.securityAlerts}
                      disabled={savingPrefs}
                      onChange={() => void handlePreferenceToggle('securityAlerts')}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                    />
                  </div>
                </div>
              ) : (
                <p className="text-[12px] text-[#64748b]">Loading preferences...</p>
              )}
            </div>
          ) : (
            <>
              {/* Filter Tabs */}
              <div className="px-3 py-1.5 border-b border-[#f1f5f9] flex items-center gap-2 bg-white">
                <button
                  type="button"
                  onClick={() => setActiveTab('all')}
                  className={`px-2.5 py-1 text-[11.5px] font-semibold rounded-lg transition-colors cursor-pointer ${
                    activeTab === 'all'
                      ? 'bg-[#0f172a] text-white shadow-2xs'
                      : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f8fafc]'
                  }`}
                  data-testid="tab-all"
                >
                  All ({notifications.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('unread')}
                  className={`px-2.5 py-1 text-[11.5px] font-semibold rounded-lg transition-colors cursor-pointer ${
                    activeTab === 'unread'
                      ? 'bg-[#0f172a] text-white shadow-2xs'
                      : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f8fafc]'
                  }`}
                  data-testid="tab-unread"
                >
                  Unread ({unreadItems.length})
                </button>
              </div>

              {/* Notification List Body */}
              <div className="flex-1 overflow-y-auto divide-y divide-[#f8fafc] max-h-[380px] bg-white">
                {loading && notifications.length === 0 && (
                  <div className="p-6 text-center text-[#64748b]">
                    <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    <p className="text-[12px]">Loading notifications...</p>
                  </div>
                )}

                {error && notifications.length === 0 && (
                  <div className="p-5 text-center">
                    <p className="text-[12px] text-rose-600 mb-2">{error}</p>
                    <button
                      type="button"
                      onClick={() => void refresh()}
                      className="px-2.5 py-1 text-[11px] font-semibold text-[#0f172a] bg-[#f1f5f9] hover:bg-[#e2e8f0] rounded-lg transition-colors cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {!loading && filteredNotifications.length === 0 && (
                  <div className="p-8 text-center">
                    <div className="w-9 h-9 rounded-xl bg-slate-100 text-[#64748b] flex items-center justify-center mx-auto mb-2.5">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <p className="text-[13px] font-bold text-[#0f172a]">
                      {activeTab === 'unread' ? 'All caught up!' : 'No notifications yet'}
                    </p>
                    <p className="text-[11.5px] text-[#64748b] mt-0.5">
                      {activeTab === 'unread'
                        ? 'You have zero unread notifications.'
                        : 'Operational and workflow alerts will appear here in real time.'}
                    </p>
                  </div>
                )}

                {filteredNotifications.map((n) => {
                  const style = getCategoryStyles(n.category);
                  const isUnread = !n.readAt;

                  return (
                    <div
                      key={n.id}
                      onClick={() => handleItemClick(n)}
                      className={`p-3 flex items-start gap-2.5 hover:bg-[#f8fafc] transition-colors cursor-pointer group ${
                        isUnread ? 'bg-emerald-50/20' : ''
                      }`}
                      data-testid="notification-item"
                    >
                      <div className={`p-1.5 rounded-lg border flex-none mt-0.5 ${style.bg}`}>
                        {style.icon}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className={`text-[12.5px] truncate leading-tight ${isUnread ? 'font-bold text-[#0f172a]' : 'font-medium text-[#334155]'}`}>
                            {n.title}
                          </p>
                          <span className="text-[10px] text-[#94a3b8] flex-none font-mono">
                            {formatRelativeTime(n.createdAt)}
                          </span>
                        </div>

                        <p className="text-[11.5px] text-[#64748b] line-clamp-2 mt-0.5 leading-snug">
                          {n.body}
                        </p>
                      </div>

                      <div className="flex items-center gap-0.5 flex-none self-center">
                        {isUnread && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void markAsRead(n.id);
                            }}
                            className="p-1 rounded text-[#94a3b8] hover:text-emerald-600 hover:bg-emerald-50 transition-colors cursor-pointer"
                            title="Mark as read"
                            aria-label="Mark as read"
                            data-testid="mark-read-btn"
                          >
                            <span className="block w-2 h-2 rounded-full bg-emerald-500" />
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteNotification(n.id);
                          }}
                          className="p-1 rounded text-slate-300 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 focus:opacity-100"
                          title="Dismiss notification"
                          aria-label="Dismiss notification"
                          data-testid="delete-notification-btn"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Footer */}
          <div className="px-4 py-2 border-t border-[#f1f5f9] bg-[#fafbfc] flex items-center justify-between text-[10.5px] text-[#94a3b8]">
            <span>Nvara Realtime Push Subsystem</span>
            <span className="font-mono">FCM v1 Active</span>
          </div>
        </div>
      )}
    </div>
  );
}
