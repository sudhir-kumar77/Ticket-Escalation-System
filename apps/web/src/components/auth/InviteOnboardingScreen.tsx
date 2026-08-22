import React, { useEffect, useState } from 'react'
import { getInvitationDetails, acceptInvitation, type InvitationDetails } from '../../services/authApi'
import { evaluatePassword } from '../ui/PasswordStrengthMeter'
import { ArrowRightIcon, CheckIcon, Spinner } from '../ui/icons'
import type { User } from '../../domain/ticket'

interface InviteOnboardingScreenProps {
  token: string
  onOnboardingComplete: (user: User) => void
  onCancel: () => void
}

function formatExpiryDate(expiresAtStr?: string): string {
  if (!expiresAtStr) return 'Invitation expires 7 days after it was sent.'
  try {
    const d = new Date(expiresAtStr)
    if (isNaN(d.getTime())) return 'Invitation expires 7 days after it was sent.'
    return `Invitation expires on ${d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`
  } catch {
    return 'Invitation expires 7 days after it was sent.'
  }
}

export const InviteOnboardingScreen: React.FC<InviteOnboardingScreenProps> = ({
  token,
  onOnboardingComplete,
  onCancel,
}) => {
  const [invite, setInvite] = useState<InvitationDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isExpired, setIsExpired] = useState(false)

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)
    setIsExpired(false)

    if (!token || token.length < 16) {
      setLoading(false)
      setError('This invitation link is invalid or incomplete.')
      return
    }

    getInvitationDetails(token)
      .then((data) => {
        if (isMounted) {
          setInvite(data)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (isMounted) {
          const msg = err.message || 'This invitation link is invalid or has expired.'
          if (msg.toLowerCase().includes('expired')) {
            setIsExpired(true)
          }
          setError(msg)
          setLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [token])

  const passwordEvaluation = evaluatePassword(password)
  const passwordsMatch = password.length > 0 && confirmPassword.length > 0 && password === confirmPassword
  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    if (password.length < 8) {
      setSubmitError('Password must be at least 8 characters long.')
      return
    }

    if (password !== confirmPassword) {
      setSubmitError('Passwords do not match.')
      return
    }

    try {
      setSubmitting(true)
      const user = await acceptInvitation(token, password)
      onOnboardingComplete(user)
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to accept invitation. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f4f6f5] text-[#0b131b]">
      {/* ── Topbar Navigation ── */}
      <header className="h-16 border-b border-[#e2e8e5] bg-white px-6 sm:px-12 flex items-center justify-between sticky top-0 z-10 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#0b131b] text-white flex items-center justify-center font-bold text-sm tracking-tight shadow-xs">
            N
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-[15px] tracking-tight text-[#0b131b] leading-tight">
              Nvara Media
            </span>
            <span className="text-[11.5px] font-medium text-[#5a6e7f] leading-tight">
              Team Onboarding
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#5a6e7f] hover:text-[#0b131b] px-3 py-1.5 rounded-lg border border-[#cbd5d0] hover:bg-[#f4f6f5] transition-colors cursor-pointer select-none shadow-2xs"
        >
          <span>←</span>
          <span>Sign In</span>
        </button>
      </header>

      {/* ── Main Content Area ── */}
      <main className="flex-1 flex items-center justify-center px-4 py-10 sm:py-14">
        <div className="max-w-[480px] w-full space-y-6">
          {/* Loading State */}
          {loading ? (
            <div className="bg-white rounded-2xl border border-[#e2e8e5] p-10 shadow-md text-center space-y-4">
              <div className="w-9 h-9 border-2 border-[#0b131b] border-t-transparent rounded-full animate-spin mx-auto" />
              <div>
                <h3 className="text-[15px] font-bold text-[#0b131b]">Verifying invitation</h3>
                <p className="text-[13px] text-[#5a6e7f] mt-1">Connecting to workspace...</p>
              </div>
            </div>
          ) : error ? (
            /* Expired or Invalid State */
            <div className="bg-white rounded-2xl border border-[#e2e8e5] p-8 sm:p-9 shadow-md text-center space-y-5">
              <div
                className={`w-12 h-12 rounded-2xl mx-auto flex items-center justify-center text-xl font-bold shadow-xs ${
                  isExpired
                    ? 'bg-[#fef3c7] text-[#b45309] border border-[#fde68a]'
                    : 'bg-[#fee2e2] text-[#b91c1c] border border-[#fecaca]'
                }`}
              >
                {isExpired ? '⏳' : '✕'}
              </div>

              <div className="space-y-1.5">
                <h2 className="text-[20px] font-bold text-[#0b131b] tracking-tight">
                  {isExpired ? 'This invitation has expired' : 'Invitation unavailable'}
                </h2>
                <p className="text-[13.5px] text-[#5a6e7f] leading-relaxed max-w-[380px] mx-auto">
                  {isExpired
                    ? 'This invitation link is no longer active. Please ask your Project Manager to send you a fresh invitation link.'
                    : error}
                </p>
              </div>

              <div className="pt-2 space-y-2.5">
                <button
                  type="button"
                  onClick={onCancel}
                  className="w-full py-2.5 px-4 rounded-xl font-semibold text-[13.5px] bg-[#0b131b] hover:bg-[#1e293b] text-white transition-all shadow-xs cursor-pointer"
                >
                  Go to Sign In
                </button>
              </div>
            </div>
          ) : invite ? (
            /* Active Invitation Experience */
            <>
              {/* Hero Header */}
              <div className="text-center space-y-2">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#ecfdf5] border border-[#d1fae5] text-[12px] font-semibold text-[#065f46]">
                  <span className="w-2 h-2 rounded-full bg-[#059669]" />
                  <span>Team Member Invitation</span>
                </div>
                <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight text-[#0b131b] leading-tight">
                  You're invited to join {invite.organizationName}
                </h1>
                <p className="text-[14px] text-[#5a6e7f] max-w-[400px] mx-auto leading-relaxed">
                  Set up your account to start collaborating with your team.
                </p>
              </div>

              {/* Elevated Card */}
              <div className="bg-white rounded-2xl border border-[#e2e8e5] p-7 sm:p-8 shadow-md space-y-6">
                {/* ── Invitation Identity Context ── */}
                <div className="bg-[#f8faf9] border border-[#e2e8e5] rounded-xl p-4 space-y-3">
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="text-[12px] font-medium text-[#5a6e7f]">Workspace</span>
                    <span className="text-[13px] font-bold text-[#0b131b] text-right">
                      {invite.organizationName}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-[12px] font-medium text-[#5a6e7f]">Invited As</span>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-[12px] font-semibold bg-[#ecfdf5] text-[#065f46] border border-[#a7f3d0]">
                        {invite.role === 'project_manager' ? 'Project Manager' : 'Operations Specialist'}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-[#5a6e7f] text-right">
                      {invite.role === 'project_manager'
                        ? 'Manages requests, assignments, team members, and escalations.'
                        : 'Handles assigned requests and client work.'}
                    </p>
                  </div>

                  <div className="flex justify-between items-center gap-2 pt-1 border-t border-[#e2e8e5]/70">
                    <span className="text-[12px] font-medium text-[#5a6e7f]">Work Email</span>
                    <span className="font-mono text-[12.5px] text-[#0b131b] bg-white px-2 py-0.5 rounded border border-[#e2e8e5]">
                      {invite.email}
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-[11.5px] text-[#788896]">
                    <span>Invited by</span>
                    <span className="font-medium text-[#5a6e7f]">{invite.inviterName}</span>
                  </div>
                </div>

                {/* ── Form Section ── */}
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-1">
                    <h2 className="text-[15px] font-bold text-[#0b131b] tracking-tight">
                      Create your password
                    </h2>
                    <p className="text-[12.5px] text-[#5a6e7f]">
                      Choose a private password you'll use to sign in.
                    </p>
                  </div>

                  {submitError && (
                    <div
                      className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-[12.5px] text-rose-700 font-medium"
                      role="alert"
                    >
                      {submitError}
                    </div>
                  )}

                  {/* Password Input */}
                  <div className="space-y-1.5">
                    <label
                      htmlFor="invite-password"
                      className="block text-[12.5px] font-semibold text-[#2c3e50]"
                    >
                      Password
                    </label>
                    <div className="relative">
                      <input
                        id="invite-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Create a password"
                        className="w-full rounded-xl border border-[#cbd5d0] bg-white px-3.5 py-2.5 pr-10 text-[14px] text-[#0b131b] placeholder:text-[#94a3b8] focus:border-[#0b131b] focus:ring-1 focus:ring-[#0b131b] outline-none transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5a6e7f] hover:text-[#0b131b] p-1 transition-colors cursor-pointer"
                      >
                        {showPassword ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>

                    {/* Compact Segmented Strength Meter */}
                    {password.length > 0 && (
                      <div className="pt-1.5 space-y-2">
                        <div className="flex justify-between items-center text-[11.5px] font-medium text-[#5a6e7f]">
                          <span>Password strength</span>
                          <span
                            className={
                              passwordEvaluation.score <= 1
                                ? 'text-rose-600 font-semibold'
                                : passwordEvaluation.score === 2
                                ? 'text-amber-600 font-semibold'
                                : 'text-emerald-700 font-semibold'
                            }
                          >
                            {passwordEvaluation.label}
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5 h-1.5">
                          {[0, 1, 2, 3].map((step) => (
                            <div
                              key={step}
                              className={`h-full rounded-full transition-all duration-300 ${
                                step <= passwordEvaluation.score - 1
                                  ? passwordEvaluation.color
                                  : 'bg-[#e2e8e5]'
                              }`}
                            />
                          ))}
                        </div>

                        {/* Secondary Requirements Checklist */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-[11px] text-[#5a6e7f]">
                          <div className={`flex items-center gap-1.5 ${passwordEvaluation.hasMinLength ? 'text-emerald-700 font-medium' : ''}`}>
                            <span>{passwordEvaluation.hasMinLength ? '✓' : '○'}</span>
                            <span>8+ characters</span>
                          </div>
                          <div className={`flex items-center gap-1.5 ${passwordEvaluation.hasMixedCase ? 'text-emerald-700 font-medium' : ''}`}>
                            <span>{passwordEvaluation.hasMixedCase ? '✓' : '○'}</span>
                            <span>Upper & lowercase</span>
                          </div>
                          <div className={`flex items-center gap-1.5 ${passwordEvaluation.hasNumber ? 'text-emerald-700 font-medium' : ''}`}>
                            <span>{passwordEvaluation.hasNumber ? '✓' : '○'}</span>
                            <span>At least 1 number</span>
                          </div>
                          <div className={`flex items-center gap-1.5 ${passwordEvaluation.hasSpecialChar ? 'text-emerald-700 font-medium' : ''}`}>
                            <span>{passwordEvaluation.hasSpecialChar ? '✓' : '○'}</span>
                            <span>Special character</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Confirm Password Input */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center">
                      <label
                        htmlFor="invite-confirm-password"
                        className="block text-[12.5px] font-semibold text-[#2c3e50]"
                      >
                        Confirm password
                      </label>
                      {passwordsMatch && (
                        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-emerald-700">
                          <CheckIcon size={12} />
                          <span>Passwords match</span>
                        </span>
                      )}
                      {passwordMismatch && (
                        <span className="text-[11.5px] font-medium text-amber-700">
                          Passwords don't match
                        </span>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        id="invite-confirm-password"
                        name="confirmPassword"
                        type={showConfirmPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Re-enter your password"
                        className={`w-full rounded-xl border bg-white px-3.5 py-2.5 pr-10 text-[14px] text-[#0b131b] placeholder:text-[#94a3b8] outline-none transition-all ${
                          passwordMismatch
                            ? 'border-amber-300 focus:border-amber-500 focus:ring-1 focus:ring-amber-500'
                            : passwordsMatch
                            ? 'border-emerald-400 focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600'
                            : 'border-[#cbd5d0] focus:border-[#0b131b] focus:ring-1 focus:ring-[#0b131b]'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5a6e7f] hover:text-[#0b131b] p-1 transition-colors cursor-pointer"
                      >
                        {showConfirmPassword ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Primary CTA */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={submitting || password.length < 8 || password !== confirmPassword}
                      className="w-full py-2.5 px-4 rounded-xl font-semibold text-[13.5px] bg-[#0b131b] hover:bg-[#1e293b] text-white transition-all shadow-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {submitting ? (
                        <>
                          <Spinner size={14} />
                          <span>Joining workspace...</span>
                        </>
                      ) : (
                        <>
                          <span>Join Workspace</span>
                          <ArrowRightIcon size={14} />
                        </>
                      )}
                    </button>
                  </div>
                </form>

                {/* Trust & Expiry Footnote */}
                <div className="pt-2 border-t border-[#e2e8e5] text-center space-y-1">
                  <p className="text-[11.5px] text-[#5a6e7f]">
                    🔒 Your password is private and never shared with your inviter.
                  </p>
                  <p className="text-[11px] text-[#788896]">
                    {formatExpiryDate(invite.expiresAt)}
                  </p>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </div>
  )
}
