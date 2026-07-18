import { runtimeFetch } from "../lib/runtime-fetch"
import type { AutoDecisionRecord } from "./types"

/** Per-session cap, mirroring the HaoCode server's FIFO limit. */
export const AUTO_DECISION_LIMIT = 100

const DECISIONS = new Set(["approve", "reject"])
const SOURCES = new Set(["rule", "review", "sandbox"])
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"])

/**
 * Normalize one raw record from the HaoCode `/auto-decisions` route into the
 * UI shape. Unknown enum values fail closed (unknown decisions display as
 * reject, unknown risk levels as high), matching the server's normalization.
 * Returns null when the record is structurally unusable.
 */
export function normalizeAutoDecisionRecord(raw: unknown): AutoDecisionRecord | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const sessionID = typeof record.sessionId === "string" ? record.sessionId : ""
  const actionId = typeof record.actionId === "string" ? record.actionId : ""
  if (!sessionID || !actionId) return null
  const decision = typeof record.decision === "string" && DECISIONS.has(record.decision)
    ? record.decision as AutoDecisionRecord["decision"]
    : "reject"
  const source = typeof record.source === "string" && SOURCES.has(record.source)
    ? record.source as AutoDecisionRecord["source"]
    : "rule"
  const riskLevel = typeof record.riskLevel === "string" && RISK_LEVELS.has(record.riskLevel)
    ? record.riskLevel as AutoDecisionRecord["riskLevel"]
    : "high"
  return {
    id: typeof record.id === "string" && record.id ? record.id : `req_${actionId}`,
    sessionID,
    requestID: `req_${actionId}`,
    permission: typeof record.tool === "string" && record.tool ? record.tool : "tool",
    decision,
    source,
    riskLevel,
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(record.input && typeof record.input === "object"
      ? { input: record.input as Record<string, unknown> }
      : {}),
    ...(typeof record.time === "number" ? { time: record.time } : {}),
  }
}

/**
 * Fetch the persisted auto-decision history for one session from the HaoCode
 * compatibility server. Returns null on ANY failure (transport, non-2xx,
 * malformed body) — callers must treat null as "unknown" and preserve
 * existing state; only a successful (possibly empty) array is authoritative.
 * Non-HaoCode runtimes answer 404, which is a normal null result.
 */
export async function fetchAutoDecisionRecords(
  directory: string,
  sessionID: string,
): Promise<AutoDecisionRecord[] | null> {
  let response: Response
  try {
    response = await runtimeFetch("/api/auto-decisions", {
      query: { directory, sessionID },
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  const data: unknown = await response.json().catch(() => null)
  if (!Array.isArray(data)) return null
  return data
    .map(normalizeAutoDecisionRecord)
    .filter((record): record is AutoDecisionRecord => record !== null)
}

const sameRecord = (left: AutoDecisionRecord, right: AutoDecisionRecord): boolean => (
  left.requestID === right.requestID
  && left.decision === right.decision
  && left.source === right.source
  && left.riskLevel === right.riskLevel
  && left.permission === right.permission
  && left.reason === right.reason
  && left.time === right.time
)

/**
 * Merge a fetched history page into the live per-session list, keyed by
 * requestID. Fetched (server-persisted) records win over live SSE records on
 * conflict because they carry the authoritative id/time. Result is sorted by
 * time and capped at AUTO_DECISION_LIMIT. Returns null when the merge would
 * not change anything, so callers can skip the store write.
 */
export function mergeAutoDecisionRecords(
  existing: AutoDecisionRecord[] | undefined,
  incoming: AutoDecisionRecord[],
): AutoDecisionRecord[] | null {
  if (!existing || existing.length === 0) {
    return incoming.length > 0 ? sortAndCap(incoming) : null
  }
  const incomingByRequestID = new Map(incoming.map((record) => [record.requestID, record]))
  let changed = false
  const merged = existing.map((record) => {
    const update = incomingByRequestID.get(record.requestID)
    if (!update) return record
    incomingByRequestID.delete(record.requestID)
    if (sameRecord(record, update)) return record
    changed = true
    return update
  })
  if (incomingByRequestID.size > 0) {
    changed = true
    merged.push(...incomingByRequestID.values())
  }
  if (!changed) return null
  return sortAndCap(merged)
}

const sortAndCap = (records: AutoDecisionRecord[]): AutoDecisionRecord[] => (
  records
    .slice()
    .sort((left, right) => (left.time ?? 0) - (right.time ?? 0) || (left.requestID < right.requestID ? -1 : 1))
    .slice(-AUTO_DECISION_LIMIT)
)
