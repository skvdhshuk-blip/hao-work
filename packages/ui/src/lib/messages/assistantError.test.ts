import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, StructuredError } from '@/lib/opencode/model';

import { dict } from '@/lib/i18n/messages/en';
import { formatMessage } from '@/lib/i18n/store';
import { assistantErrorNotice, isStoppedTurnError } from './assistantError';

const t = formatMessage.bind(null, dict);
const noticeFor = (info: AssistantMessage) => assistantErrorNotice(info, t);
const stoppedMessage = dict['chat.assistantError.stoppedBeforeSend'];

const assistant = (error?: StructuredError): AssistantMessage => ({
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1 },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
  error,
});

describe('isStoppedTurnError', () => {
  test('reads the abort OpenCode records for a stopped step as a stop', () => {
    // Pressing Stop makes OpenCode record an error on the assistant message:
    // type `MessageAbortedError`, message "Step interrupted". It is not a send
    // failure, so the transcript must not call it one.
    expect(isStoppedTurnError('MessageAbortedError', 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError('MessageAbortedError', '')).toBe(true);
  });

  test('recognises the interruption by its message when only the v2 type survives', () => {
    // A reload projects the stored error, which carries `type` but no `name`;
    // the detail is all the classifier sees.
    expect(isStoppedTurnError(undefined, 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError(undefined, 'Step interrupted.')).toBe(true);
  });

  test('keeps the locally synthesized stop shape', () => {
    // `interruptedTurnToolParts` closes an interrupted turn itself with
    // `{ type: "aborted", message: "aborted" }`.
    expect(isStoppedTurnError(undefined, 'aborted')).toBe(true);
    expect(isStoppedTurnError(undefined, '  ABORTED  ')).toBe(true);
  });

  test('leaves a real failure that merely mentions aborting as a failure', () => {
    // A dropped connection is not the user pressing Stop, and telling them it
    // was would hide the reason their turn ended.
    expect(isStoppedTurnError(undefined, 'Connection aborted')).toBe(false);
    expect(isStoppedTurnError('UnknownError', 'Stream aborted by the provider')).toBe(false);
    expect(isStoppedTurnError(undefined, 'Model unavailable')).toBe(false);
  });

});

describe('assistantErrorNotice', () => {
  test('does not call a stopped turn a failed send', () => {
    // The reported symptom: Stop produced "HaoCode failed to send message
    // with error: Step interrupted" even though the message was delivered and
    // the user stopped the step on purpose.
    const notice = noticeFor(assistant({ type: 'MessageAbortedError', message: 'Step interrupted' }));
    expect(notice).toEqual({ text: stoppedMessage });
    expect(notice?.text).not.toContain('failed to send');
  });

  test('keeps the stop sentence for the local close this client writes', () => {
    expect(noticeFor(assistant({ type: 'aborted', message: 'aborted' })))
      .toEqual({ text: stoppedMessage });
  });

  test('still names a real failure as one', () => {
    expect(noticeFor(assistant({ type: 'UnknownError', message: 'Model unavailable' })))
      .toEqual({ text: 'HaoCode failed to send message with error:\n`Model unavailable`' });
  });

  test('keeps the retry notice ahead of the stop classification', () => {
    expect(noticeFor(assistant({ type: 'SessionRetry', message: 'Retrying in 5s' })))
      .toEqual({ text: 'HaoCode failed to send a message. Retry attempt info: \n`Retrying in 5s`' });
  });

  test('names an authentication failure the way the rest of the product does', () => {
    expect(noticeFor(assistant({ type: 'ProviderAuthError', message: 'invalid token' })))
      .toEqual({ text: 'Authentication failed for this provider. Please re-authenticate and retry.' });
  });

  test('shows nothing for a message without an error', () => {
    expect(noticeFor(assistant())).toBeNull();
  });
});
