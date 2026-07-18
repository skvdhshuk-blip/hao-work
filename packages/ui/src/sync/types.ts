import type {
  Agent,
  Command,
  Config,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"

export type FileDiff = {
  file?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
  [key: string]: unknown
}

/**
 * Adapter-owned SSE event emitted by the HaoCode compatibility server when a
 * smart-mode worker auto-resolves a permission in-process. Not part of the
 * SDK `Event` union, so reducers compare against this `string`-typed constant
 * (a literal-typed constant would fail union comparability checks).
 */
export const PERMISSION_AUTO_RESOLVED_EVENT: string = "permission.auto_resolved"

/**
 * Audit record for one auto-resolved permission decision. Built from
 * `permission.auto_resolved` SSE payloads and from the HaoCode
 * `/auto-decisions` backfill route. Bounded per session (see
 * AUTO_DECISION_LIMIT in ./auto-decisions).
 */
export type AutoDecisionRecord = {
  id: string
  sessionID: string
  requestID: string
  permission: string
  decision: "approve" | "reject"
  source: "rule" | "review" | "sandbox"
  riskLevel: "low" | "medium" | "high" | "critical"
  reason: string
  input?: Record<string, unknown>
  time?: number
}

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

/** Per-directory store state */
export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  autoDecision: Record<string, AutoDecisionRecord[]>
  mcp: Record<string, McpStatus>
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

/** Global store state */
export type GlobalState = {
  ready: boolean
  error?: InitError
  path: Path
  projects: Project[]
  providers: ProviderListResponse
  providerAuth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  sessionTodo: Record<string, Todo[]>
}

type InitError = {
  type: "init"
  message: string
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
  hasPendingBlockingRequests?: (directory: string) => boolean
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
  hasPendingBlockingRequests: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_CACHE_LIMIT = 40

export const INITIAL_STATE: State = {
  project: "",
  projectMeta: undefined,
  icon: undefined,
  provider: { all: [], connected: [], default: {} },
  config: {},
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  status: "loading",
  agent: [],
  command: [],
  session: [],
  sessionTotal: 0,
  session_status: {},
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  autoDecision: {},
  mcp: {},
  lsp: [],
  vcs: undefined,
  limit: 5,
  message: {},
  part: {},
}

export const INITIAL_GLOBAL_STATE: GlobalState = {
  ready: false,
  path: { state: "", config: "", worktree: "", directory: "", home: "" },
  projects: [],
  providers: { all: [], connected: [], default: {} },
  providerAuth: {},
  config: {},
  reload: undefined,
  sessionTodo: {},
}
