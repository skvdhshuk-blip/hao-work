import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    autoDecision: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("skips stale session.updated events so a newer title survives", () => {
    const draft = state({ session: [buildSession("New Title", { created: 1, updated: 20 })] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: buildSession("Old Title", { created: 1, updated: 10 }),
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session[0]?.title).toBe("New Title")
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })

  test("records permission.auto_resolved into autoDecision without touching pending permissions", () => {
    const draft = state()

    const changed = applyDirectoryEvent(draft, {
      type: "permission.auto_resolved",
      properties: {
        sessionID: "ses_1",
        requestID: "req_act_1",
        permission: "Bash",
        metadata: {
          input: { command: "pwd" },
          description: "Read-only command allowlist",
          _fe_interruptId: "int_1",
          _fe_actionId: "act_1",
          _fe_autoDecision: "approve",
          _fe_source: "rule",
          _fe_riskLevel: "low",
        },
      },
    } as unknown as Event)

    expect(changed).toBe(true)
    expect(draft.permission).toEqual({})
    expect(draft.autoDecision.ses_1).toHaveLength(1)
    const record = draft.autoDecision.ses_1[0]
    expect(record?.id).toBe("req_act_1")
    expect(record?.sessionID).toBe("ses_1")
    expect(record?.requestID).toBe("req_act_1")
    expect(record?.permission).toBe("Bash")
    expect(record?.decision).toBe("approve")
    expect(record?.source).toBe("rule")
    expect(record?.riskLevel).toBe("low")
    expect(record?.reason).toBe("Read-only command allowlist")
    expect(record?.input).toEqual({ command: "pwd" })
    expect(typeof record?.time).toBe("number")
  })

  test("normalizes unknown auto_resolved enums conservatively and ignores malformed payloads", () => {
    const draft = state()

    const changed = applyDirectoryEvent(draft, {
      type: "permission.auto_resolved",
      properties: {
        sessionID: "ses_1",
        requestID: "req_act_2",
        permission: "Write",
        metadata: {
          _fe_autoDecision: "bogus",
          _fe_source: "bogus",
          _fe_riskLevel: "bogus",
          description: 42,
        },
      },
    } as unknown as Event)

    expect(changed).toBe(true)
    const record = draft.autoDecision.ses_1[0]
    expect(record?.decision).toBe("reject")
    expect(record?.source).toBe("rule")
    expect(record?.riskLevel).toBe("high")
    expect(record?.reason).toBe("")

    expect(applyDirectoryEvent(draft, {
      type: "permission.auto_resolved",
      properties: { sessionID: "", requestID: "req_act_3" },
    } as unknown as Event)).toBe(false)
    expect(applyDirectoryEvent(draft, {
      type: "permission.auto_resolved",
      properties: { sessionID: "ses_1" },
    } as unknown as Event)).toBe(false)
    expect(draft.autoDecision.ses_1).toHaveLength(1)
  })

  test("dedupes auto_resolved by requestID and skips identical repeats", () => {
    const draft = state()
    const event = {
      type: "permission.auto_resolved",
      properties: {
        sessionID: "ses_1",
        requestID: "req_act_1",
        permission: "Bash",
        metadata: {
          description: "allowlisted",
          _fe_autoDecision: "approve",
          _fe_source: "rule",
          _fe_riskLevel: "low",
        },
      },
    } as unknown as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.autoDecision.ses_1).toHaveLength(1)

    const changedDecision = {
      type: "permission.auto_resolved",
      properties: {
        sessionID: "ses_1",
        requestID: "req_act_1",
        permission: "Bash",
        metadata: {
          description: "allowlisted",
          _fe_autoDecision: "reject",
          _fe_source: "review",
          _fe_riskLevel: "medium",
        },
      },
    } as unknown as Event
    expect(applyDirectoryEvent(draft, changedDecision)).toBe(true)
    expect(draft.autoDecision.ses_1).toHaveLength(1)
    const record = draft.autoDecision.ses_1[0]
    expect(record?.decision).toBe("reject")
    expect(record?.source).toBe("review")
    expect(record?.riskLevel).toBe("medium")
  })

  test("caps autoDecision history per session", () => {
    const draft = state()
    for (let index = 0; index < 105; index += 1) {
      applyDirectoryEvent(draft, {
        type: "permission.auto_resolved",
        properties: {
          sessionID: "ses_1",
          requestID: `req_act_${index}`,
          permission: "Read",
          metadata: { _fe_autoDecision: "approve", _fe_source: "rule", _fe_riskLevel: "low" },
        },
      } as unknown as Event)
    }

    expect(draft.autoDecision.ses_1).toHaveLength(100)
    expect(draft.autoDecision.ses_1[0]?.requestID).toBe("req_act_5")
    expect(draft.autoDecision.ses_1.at(-1)?.requestID).toBe("req_act_104")
  })
})
