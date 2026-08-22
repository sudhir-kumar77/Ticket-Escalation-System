import React from 'react'

export function PrimaryBtn({
  onClick,
  disabled,
  busy,
  children,
  className = '',
  type = 'button',
}: {
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  children: React.ReactNode
  className?: string
  type?: 'button' | 'submit' | 'reset'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-2 h-9 px-3.5 rounded-lg text-[13px] font-semibold bg-[#0b131b] hover:bg-[#152332] active:bg-[#000000] text-white border border-[#0b131b] shadow-xs transition-colors duration-100 disabled:opacity-50 disabled:cursor-not-allowed select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-[#059669]/40 ${className}`}
    >
      {busy && (
        <svg
          className="animate-spin -ml-0.5"
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
          <path d="M12 7a5 5 0 01-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {children}
    </button>
  )
}

export function SecondaryBtn({
  onClick,
  disabled,
  children,
  className = '',
  type = 'button',
}: {
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-white hover:bg-[#f4f6f5] active:bg-[#edf0ee] text-[#2c3e50] border border-[#cbd5d0] hover:border-[#8da0b0] shadow-xs transition-colors duration-100 disabled:opacity-50 disabled:cursor-not-allowed select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-[#059669]/40 ${className}`}
    >
      {children}
    </button>
  )
}

export function DangerBtn({
  onClick,
  disabled,
  busy,
  children,
  className = '',
  type = 'button',
}: {
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  children: React.ReactNode
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg text-[13px] font-semibold bg-[#e11d48] hover:bg-[#be123c] active:bg-[#9f1239] text-white border border-[#e11d48] shadow-xs transition-colors duration-100 disabled:opacity-50 disabled:cursor-not-allowed select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-[#e11d48]/40 ${className}`}
    >
      {busy ? 'Processing...' : children}
    </button>
  )
}

export function NavItem({
  active,
  icon,
  badge,
  children,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  badge?: number
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150 select-none cursor-pointer group relative ${
        active
          ? 'bg-[#16202c] text-white font-semibold shadow-xs border border-[#223244]'
          : 'text-[#94a3b8] hover:bg-[#131b24] hover:text-white border border-transparent'
      }`}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-md bg-[#10b981]"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-2.5 min-w-0 pl-0.5">
        <span
          className={`flex-none transition-colors ${
            active ? 'text-[#10b981]' : 'text-[#64748b] group-hover:text-[#cbd5e1]'
          }`}
        >
          {icon}
        </span>
        <span className="truncate">{children}</span>
      </div>
      {typeof badge === 'number' && badge > 0 && (
        <span
          className={`px-2 py-0.5 rounded-full text-[10.5px] font-semibold transition-colors ${
            active
              ? 'bg-[#10b981] text-[#064e3b]'
              : 'bg-[#141b22] text-[#94a3b8] border border-[#223244]/60'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  )
}
