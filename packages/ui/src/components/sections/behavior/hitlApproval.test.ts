import { describe, expect, test } from 'bun:test';
import {
  buildHitlReviewModelPatch,
  readHitlApprovalConfig,
  sanitizeHitlApprovalMode,
  sanitizeHitlReviewModel,
} from './hitlApproval';

describe('hitlApproval config helpers', () => {
  test('sanitizeHitlApprovalMode keeps known modes and falls back to smart', () => {
    expect(sanitizeHitlApprovalMode('ask')).toBe('ask');
    expect(sanitizeHitlApprovalMode('smart')).toBe('smart');
    expect(sanitizeHitlApprovalMode('auto')).toBe('auto');
    expect(sanitizeHitlApprovalMode('bogus')).toBe('smart');
    expect(sanitizeHitlApprovalMode(undefined)).toBe('smart');
    expect(sanitizeHitlApprovalMode(null)).toBe('smart');
    expect(sanitizeHitlApprovalMode(42)).toBe('smart');
  });

  test('sanitizeHitlReviewModel trims strings and rejects non-strings', () => {
    expect(sanitizeHitlReviewModel('deepseek-reasoner')).toBe('deepseek-reasoner');
    expect(sanitizeHitlReviewModel('  deepseek-reasoner  ')).toBe('deepseek-reasoner');
    expect(sanitizeHitlReviewModel('')).toBe('');
    expect(sanitizeHitlReviewModel('   ')).toBe('');
    expect(sanitizeHitlReviewModel(null)).toBe('');
    expect(sanitizeHitlReviewModel(undefined)).toBe('');
    expect(sanitizeHitlReviewModel(7)).toBe('');
  });

  test('readHitlApprovalConfig reads adapter keys with defaults', () => {
    expect(readHitlApprovalConfig({
      _fe_hitlMode: 'smart',
      _fe_hitlReviewModel: 'deepseek-reasoner',
      model: 'deepseek/deepseek-chat',
    })).toEqual({ mode: 'smart', reviewModel: 'deepseek-reasoner' });
    expect(readHitlApprovalConfig({})).toEqual({ mode: 'smart', reviewModel: '' });
    expect(readHitlApprovalConfig(undefined)).toEqual({ mode: 'smart', reviewModel: '' });
    expect(readHitlApprovalConfig(null)).toEqual({ mode: 'smart', reviewModel: '' });
    expect(readHitlApprovalConfig({ _fe_hitlMode: 'ask', _fe_hitlReviewModel: null }))
      .toEqual({ mode: 'ask', reviewModel: '' });
    expect(readHitlApprovalConfig({ _fe_hitlMode: 'bogus', _fe_hitlReviewModel: null }))
      .toEqual({ mode: 'smart', reviewModel: '' });
  });

  test('buildHitlReviewModelPatch maps empty input to null', () => {
    expect(buildHitlReviewModelPatch('deepseek-reasoner'))
      .toEqual({ _fe_hitlReviewModel: 'deepseek-reasoner' });
    expect(buildHitlReviewModelPatch('  deepseek-reasoner '))
      .toEqual({ _fe_hitlReviewModel: 'deepseek-reasoner' });
    expect(buildHitlReviewModelPatch('')).toEqual({ _fe_hitlReviewModel: null });
    expect(buildHitlReviewModelPatch('   ')).toEqual({ _fe_hitlReviewModel: null });
  });
});
