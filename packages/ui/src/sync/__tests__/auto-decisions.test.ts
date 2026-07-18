import { describe, expect, test } from "bun:test"
import {
  AUTO_DECISION_LIMIT,
  mergeAutoDecisionRecords,
  normalizeAutoDecisionRecord,
} from "../auto-decisions"
import type { AutoDecisionRecord } from "../types"

const serverRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "auto_1",
  sessionId: "ses_1",
  directory: "/project",
  interruptId: "int_1",
  actionId: "act_1",
  tool: "Bash",
  input: { command: "pwd" },
  decision: "approve",
  source: "rule",
  riskLevel: "low",
  reason: "Read-only command allowlist",
  time: 1000,
  ...overrides,
})

const uiRecord = (overrides: Partial<AutoDecisionRecord> = {}): AutoDecisionRecord => ({
  id: "req_act_1",
  sessionID: "ses_1",
  requestID: "req_act_1",
  permission: "Bash",
  decision: "approve",
  source: "rule",
  riskLevel: "low",
  reason: "Read-only command allowlist",
  input: { command: "pwd" },
  time: 1000,
  ...overrides,
})

describe("normalizeAutoDecisionRecord", () => {
  test("maps the server record shape to the UI shape", () => {
    expect(normalizeAutoDecisionRecord(serverRecord())).toEqual(uiRecord({ id: "auto_1" }))
  })

  test("fails closed on unknown enums and missing text", () => {
    expect(normalizeAutoDecisionRecord(serverRecord({
      decision: "bogus",
      source: "bogus",
      riskLevel: "bogus",
      reason: 42,
      tool: "",
    }))).toEqual(uiRecord({
      id: "auto_1",
      decision: "reject",
      riskLevel: "high",
      reason: "",
      permission: "tool",
    }))
  })

  test("rejects records without sessionId or actionId", () => {
    expect(normalizeAutoDecisionRecord(null)).toBe(null)
    expect(normalizeAutoDecisionRecord({})).toBe(null)
    expect(normalizeAutoDecisionRecord(serverRecord({ sessionId: "" }))).toBe(null)
    expect(normalizeAutoDecisionRecord(serverRecord({ actionId: "" }))).toBe(null)
  })
})

describe("mergeAutoDecisionRecords", () => {
  test("returns null for empty incoming and empty existing", () => {
    expect(mergeAutoDecisionRecords(undefined, [])).toBe(null)
    expect(mergeAutoDecisionRecords([], [])).toBe(null)
  })

  test("adopts incoming history when nothing is cached", () => {
    const merged = mergeAutoDecisionRecords(undefined, [uiRecord()])
    expect(merged).toHaveLength(1)
    expect(merged?.[0]?.requestID).toBe("req_act_1")
  })

  test("returns null when history is identical to the cached list", () => {
    expect(mergeAutoDecisionRecords([uiRecord()], [uiRecord()])).toBe(null)
  })

  test("keeps live-only records while adding older history", () => {
    const liveOnly = uiRecord({ requestID: "req_act_2", id: "req_act_2", time: 2000 })
    const history = [uiRecord()]
    const merged = mergeAutoDecisionRecords([liveOnly], history)
    expect(merged?.map((record) => record.requestID)).toEqual(["req_act_1", "req_act_2"])
  })

  test("server records win on conflicting content for the same requestID", () => {
    const live = uiRecord({ decision: "approve", source: "rule", time: 9999 })
    const persisted = uiRecord({ decision: "reject", source: "review", time: 1000 })
    const merged = mergeAutoDecisionRecords([live], [persisted])
    expect(merged).toHaveLength(1)
    expect(merged?.[0]?.decision).toBe("reject")
    expect(merged?.[0]?.source).toBe("review")
    expect(merged?.[0]?.time).toBe(1000)
  })

  test("sorts by time and caps at the limit", () => {
    const many = Array.from({ length: AUTO_DECISION_LIMIT + 10 }, (_, index) => uiRecord({
      id: `req_act_${index}`,
      requestID: `req_act_${index}`,
      time: index,
    }))
    const merged = mergeAutoDecisionRecords(undefined, many)
    expect(merged).toHaveLength(AUTO_DECISION_LIMIT)
    expect(merged?.[0]?.requestID).toBe("req_act_10")
    expect(merged?.at(-1)?.requestID).toBe(`req_act_${AUTO_DECISION_LIMIT + 9}`)
  })
})
