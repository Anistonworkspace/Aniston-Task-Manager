import { describe, it, expect } from 'vitest';
import { getActionSuggestions } from '../actionSuggestionCatalog';

describe('actionSuggestionCatalog', () => {
  it('returns the meeting catalog with the expected prompt ids', () => {
    const list = getActionSuggestions('meeting');
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((s) => s.id)).toEqual(
      expect.arrayContaining(['about', 'follow_email', 'next_steps', 'missed', 'actions'])
    );
  });

  it('returns the doc catalog with summarize/keypoints/rewrite/translate', () => {
    const list = getActionSuggestions('doc');
    expect(list.map((s) => s.id)).toEqual(
      expect.arrayContaining(['summarize', 'keypoints', 'rewrite', 'translate'])
    );
  });

  it('returns the board catalog including the "stuck" prompt (Plan A addition)', () => {
    const list = getActionSuggestions('board');
    expect(list.map((s) => s.id)).toEqual(
      expect.arrayContaining(['status', 'overdue', 'behind', 'stuck', 'summary'])
    );
  });

  it('returns the task catalog (Plan A new scope)', () => {
    const list = getActionSuggestions('task');
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((s) => s.id)).toEqual(
      expect.arrayContaining(['summary', 'blocked', 'next', 'priority', 'duedate'])
    );
    // every entry must have a human-readable label.
    for (const s of list) {
      expect(typeof s.label).toBe('string');
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('returns the planning catalog (Plan A new scope)', () => {
    const list = getActionSuggestions('planning');
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((s) => s.id)).toEqual(
      expect.arrayContaining(['today', 'week', 'focus', 'overload'])
    );
  });

  it('returns an empty array for unknown scopes', () => {
    expect(getActionSuggestions('galaxy')).toEqual([]);
    expect(getActionSuggestions(undefined)).toEqual([]);
    expect(getActionSuggestions(null)).toEqual([]);
  });
});
