// ── Nvara Media — Domain Model ──

export type Role = 'project_manager' | 'team_member'
export type InternalPriority = 'low' | 'medium' | 'high' | 'urgent'
export type ClientUrgency = 'flexible' | 'soon' | 'time_sensitive'
export type WorkflowStatus = 'awaiting_acknowledgement' | 'acknowledged' | 'in_progress' | 'resolved'

export type ServiceDomain =
  // Marketing
  | 'performance_marketing'
  | 'social_media_marketing'
  // IT Services
  | 'web_development'
  | 'app_development'
  // Strategy
  | 'seo'
  | 'influencer_marketing'
  // Branding
  | 'production'
  | 'graphic_design'
  // Immersive Media
  | 'animation_2d_3d'
  | 'vfx'
  | 'ar_vr'
  | 'game_development'
  // Legacy aliases for backward compatibility
  | 'digital_marketing'
  | 'web_app_development'
  | 'branding_graphic_design'
  | 'video_production'
  | 'immersive_media'

export type ServiceCategory =
  | 'Marketing'
  | 'IT Services'
  | 'Strategy'
  | 'Branding'
  | 'Immersive Media'

export const SERVICE_DOMAIN_GROUPS: Array<{
  category: ServiceCategory
  options: Array<{ slug: ServiceDomain; label: string; description: string }>
}> = [
  {
    category: 'Marketing',
    options: [
      { slug: 'performance_marketing', label: 'Performance Marketing', description: 'Google Ads, Meta Ads, Paid Search & conversion optimization' },
      { slug: 'social_media_marketing', label: 'Social Media Marketing', description: 'Organic social campaigns, community management, brand handles' },
    ],
  },
  {
    category: 'IT Services',
    options: [
      { slug: 'web_development', label: 'Web Development', description: 'Custom web applications, frontends, enterprise websites' },
      { slug: 'app_development', label: 'App Development', description: 'Native & cross-platform iOS and Android mobile applications' },
    ],
  },
  {
    category: 'Strategy',
    options: [
      { slug: 'seo', label: 'SEO', description: 'Technical SEO, search ranking, organic growth & content indexing' },
      { slug: 'influencer_marketing', label: 'Influencer Marketing', description: 'Creator partnerships, sponsored media & outreach campaigns' },
    ],
  },
  {
    category: 'Branding',
    options: [
      { slug: 'production', label: 'Production', description: 'Live video filming, post-production, commercial shoots' },
      { slug: 'graphic_design', label: 'Graphic Design', description: 'Visual identity, typography, brand guidelines & marketing collateral' },
    ],
  },
  {
    category: 'Immersive Media',
    options: [
      { slug: 'animation_2d_3d', label: 'Animation 2D/3D', description: 'Character animation, 2D motion graphics, 3D modelling & rendering' },
      { slug: 'vfx', label: 'VFX', description: 'Visual effects, compositing, CGI simulation & cinematic enhancements' },
      { slug: 'ar_vr', label: 'AR/VR', description: 'Augmented & Virtual Reality interactive spatial experiences' },
      { slug: 'game_development', label: 'Game Development', description: 'Interactive 2D/3D games, Unreal/Unity engines, interactive assets' },
    ],
  },
]

export const SERVICE_DOMAIN_LABELS: Record<ServiceDomain, string> = {
  // Marketing
  performance_marketing: 'Performance Marketing',
  social_media_marketing: 'Social Media Marketing',
  // IT Services
  web_development: 'Web Development',
  app_development: 'App Development',
  // Strategy
  seo: 'SEO',
  influencer_marketing: 'Influencer Marketing',
  // Branding
  production: 'Production',
  graphic_design: 'Graphic Design',
  // Immersive Media
  animation_2d_3d: 'Animation 2D/3D',
  vfx: 'VFX',
  ar_vr: 'AR/VR',
  game_development: 'Game Development',
  // Legacy aliases
  digital_marketing: 'Digital Marketing',
  web_app_development: 'Web & App Development',
  branding_graphic_design: 'Branding & Graphic Design',
  video_production: 'Video Production',
  immersive_media: 'Immersive Media',
}

export const SERVICE_DOMAIN_DESCRIPTIONS: Record<ServiceDomain, string> = {
  // Marketing
  performance_marketing: 'Google Ads, Meta Ads, Paid Search & conversion optimization',
  social_media_marketing: 'Organic social campaigns, community management, brand handles',
  // IT Services
  web_development: 'Custom web applications, frontends, enterprise websites',
  app_development: 'Native & cross-platform iOS and Android mobile applications',
  // Strategy
  seo: 'Technical SEO, search ranking, organic growth & content indexing',
  influencer_marketing: 'Creator partnerships, sponsored media & outreach campaigns',
  // Branding
  production: 'Live video filming, post-production, commercial shoots',
  graphic_design: 'Visual identity, typography, brand guidelines & marketing collateral',
  // Immersive Media
  animation_2d_3d: 'Character animation, 2D motion graphics, 3D modelling & rendering',
  vfx: 'Visual effects, compositing, CGI simulation & cinematic enhancements',
  ar_vr: 'Augmented & Virtual Reality interactive spatial experiences',
  game_development: 'Interactive 2D/3D games, Unreal/Unity engines, interactive assets',
  // Legacy aliases
  digital_marketing: 'Google Ads, Meta Ads, lead generation, conversion optimisation',
  web_app_development: 'Custom websites, mobile apps, web solutions',
  branding_graphic_design: 'Visual identity, brand assets, graphic design',
  video_production: 'Corporate video, filming, editing, colour grading',
  immersive_media: '2D/3D animation, VFX, AR/VR, game development',
}

export type TimelineEventType =
  | 'request_created'
  | 'assigned'
  | 'reassigned'
  | 'acknowledged'
  | 'work_started'
  | 'resolved'
  | 'sla_breached'
  | 'escalation_triggered'

export interface User {
  id: string
  name: string
  initials: string
  role: Role
  team: string
  phoneWhatsapp?: string | null
}

export interface Client {
  id: string
  name: string
  company: string
  email: string
  phone: string
}

export interface Assignment {
  assignedAt: string
  assignedBy: string
  assignee: User
  acknowledgementDeadline: string
  acknowledgedAt?: string
}

/**
 * The API-owned SLA state. It is kept with the request so operational UI can
 * describe the real server-side state without recalculating or simulating it.
 */
export interface RequestSla {
  deadlineAt: string
  status: string
  acknowledgedAt?: string
  breachedAt?: string
}

/**
 * Escalation model — internal operational escalation record.
 */
export interface Escalation {
  triggeredAt: string
  reason: string
  responsiblePerson: User
}

export interface TimelineEvent {
  id: string
  at: string
  type: TimelineEventType
  title: string
  detail: string
  actor: string
}

export interface Request {
  id: string
  version?: number
  serviceDomain: ServiceDomain
  subject: string
  description: string
  clientUrgency: ClientUrgency
  /** Internal priority — set by PM, not exposed to client */
  internalPriority: InternalPriority
  client: Client
  createdAt: string
  workflowStatus: WorkflowStatus
  assignment: Assignment
  sla?: RequestSla
  escalation?: Escalation
  timeline: TimelineEvent[]
}

export interface CreateRequestInput {
  clientName: string
  company: string
  email: string
  phone: string
  serviceDomain: ServiceDomain
  subject: string
  description: string
  clientUrgency: ClientUrgency
}

export const ACKNOWLEDGEMENT_SLA_HOURS = 24

// ── Internal Comments Thread ───────────────────────────────────────────────────

/** Author metadata for a comment — both PM and Specialist can author. */
export interface CommentAuthor {
  id: string
  name: string
  role: 'project_manager' | 'internal_team_member'
  initials: string
}

/**
 * Internal activity note on a ticket — visible only to PM and the assigned
 * Specialist. Never exposed through the public tracker or client portal.
 */
export interface RequestComment {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  author: CommentAuthor
}

// ── Team Member Capacity ───────────────────────────────────────────────────────

/**
 * Extended team member with real-time active assignment count for workload
 * capacity balancing in the reassign dropdown.
 */
export interface TeamMemberCapacity {
  id: string
  name: string
  email: string
  phoneWhatsapp?: string | null
  /** Number of currently active (non-ended) ticket assignments. */
  activeAssignmentsCount: number
}

// ── Advanced Filter State ─────────────────────────────────────────────────────

export interface RequestFilters {
  /** 'me' resolves to the current authenticated user on the server */
  assigneeId: string | null
  domain:     ServiceDomain | null
  urgency:    ClientUrgency | null
  /** 'healthy' | 'near_breach' | 'breached' */
  slaStatus:  string | null
  dateFrom:   string | null
  dateTo:     string | null
}

export const DEFAULT_FILTERS: RequestFilters = {
  assigneeId: null,
  domain:     null,
  urgency:    null,
  slaStatus:  null,
  dateFrom:   null,
  dateTo:     null,
}
