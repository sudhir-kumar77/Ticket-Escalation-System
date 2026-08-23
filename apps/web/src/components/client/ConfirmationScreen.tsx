import { useState } from 'react'
import type { SubmissionConfirmation } from '../../services/clientRequestApi'

export function ConfirmationScreen({
  request,
  onBack,
  onTrackRequest,
}: {
  request: SubmissionConfirmation
  onBack(): void
  /** Navigate to tracker with this confirmation's reference pre-filled.
   *  Optional — if not provided the CTA is omitted. */
  onTrackRequest?(reference: string): void
}) {
  const [copied, setCopied] = useState(false)

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(request.reference)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#f4f6f5] text-[#0b131b]">
      {/* ── Topbar ── */}
      <header className="h-14 border-b border-[#e2e8e5] bg-white px-6 sm:px-10 flex items-center justify-between sticky top-0 z-10 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded bg-[#0b131b] text-[#c4fb6d] border border-[#d4e157]/30 flex items-center justify-center font-bold text-xs">
            N
          </div>
          <span className="font-bold text-[14px] tracking-tight text-[#0b131b]">Nvara Media</span>
          <span className="text-[12px] font-medium text-[#64748b] hidden sm:inline-block">/ Request Confirmation</span>
        </div>
        <div className="flex items-center gap-2.5">
          <a
            href="https://nvaramedia.com"
            target="_blank"
            rel="noreferrer noopener"
            className="hidden sm:inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <span>← nvaramedia.com</span>
          </a>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold text-[#0f172a] bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-900 shadow-2xs hover:shadow-xs transition-all cursor-pointer select-none group"
            title="Return to Portal Home"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-slate-500 group-hover:text-slate-900 group-hover:-translate-x-0.5 transition-transform"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span>Portal Home</span>
          </button>
        </div>
      </header>

      {/* ── Confirmation Main ── */}
      <main className="flex-1 flex items-center justify-center px-5 py-16">
        <div className="max-w-[540px] w-full bg-white rounded-2xl border border-[#e2e8f0] p-8 sm:p-10 shadow-sm">
          <div className="w-12 h-12 rounded-2xl bg-[#0b131b] text-[#c4fb6d] border border-[#d4e157]/40 flex items-center justify-center mb-6 shadow-[0_0_20px_rgba(212,225,87,0.18)]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <p className="text-[11.5px] font-bold uppercase tracking-wider text-emerald-700 mb-1">
            Request Submitted
          </p>
          <h1 className="text-[24px] font-bold tracking-tight text-[#0f172a] mb-3">
            Your request has been received.
          </h1>
          <p className="text-[14px] text-[#475569] leading-relaxed mb-6">
            Thank you, <strong className="text-[#0f172a]">{request.clientName}</strong>. Our project management team has been notified and will review your requirements shortly.
          </p>

          {/* Reference Card with Signature Obsidian & Lime Highlight */}
          <div className="bg-[#0b131b] rounded-xl border border-[#d4e157]/30 p-4 mb-6 flex items-center justify-between shadow-[0_4px_20px_-4px_rgba(212,225,87,0.15)]">
            <div>
              <span className="block text-[10.5px] font-semibold uppercase tracking-widest text-[#94a3b8] mb-0.5">
                Tracking Reference
              </span>
              <span className="font-mono text-[19px] font-bold text-[#c4fb6d] tracking-tight">
                {request.reference}
              </span>
            </div>
            <button
              type="button"
              onClick={copyRef}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 text-[12px] font-semibold text-white transition-colors cursor-pointer"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          {/* Next Steps */}
          <div className="border-t border-[#f1f5f9] pt-6 mb-8">
            <h2 className="text-[12px] font-bold uppercase tracking-wider text-[#64748b] mb-4">
              What happens next
            </h2>
            <ol className="flex flex-col gap-3 text-[13px] text-[#334155]">
              <li className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-[#f1f5f9] text-[#0f172a] font-bold text-[11px] flex items-center justify-center flex-none mt-0.5">
                  1
                </span>
                <span>An internal project manager reviews requirement details and assigns an area specialist.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-[#f1f5f9] text-[#0f172a] font-bold text-[11px] flex items-center justify-center flex-none mt-0.5">
                  2
                </span>
                <span>The assignee acknowledges the request under our 24-hour SLA commitment.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-[#f1f5f9] text-[#0f172a] font-bold text-[11px] flex items-center justify-center flex-none mt-0.5">
                  3
                </span>
                <span>Direct coordination commences via <strong className="text-[#0f172a]">{request.email}</strong>.</span>
              </li>
            </ol>
          </div>

          {onTrackRequest && (
            <button
              type="button"
              onClick={() => onTrackRequest(request.reference)}
              className="w-full mb-3 py-2.5 rounded-md bg-[#059669] text-white text-[13.5px] font-semibold hover:bg-[#047857] transition-colors"
            >
              Track this request →
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="w-full py-2.5 rounded-md bg-[#f1f5f9] text-[#334155] text-[13.5px] font-semibold hover:bg-[#e2e8f0] transition-colors"
          >
            Return to Portal Home
          </button>
        </div>
      </main>
    </div>
  )
}
