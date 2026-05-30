import { describe, it, expect } from 'vitest';
import { isEditableTarget } from '../isEditableTarget';

function makeEl(tag, attrs = {}) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'contentEditable') el.setAttribute('contenteditable', v);
    else if (k === 'parent') v.appendChild(el);
    else el.setAttribute(k, v);
  });
  return el;
}

describe('isEditableTarget', () => {
  it('returns false for null / undefined', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });

  it('returns true for INPUT, TEXTAREA, SELECT', () => {
    expect(isEditableTarget(makeEl('input'))).toBe(true);
    expect(isEditableTarget(makeEl('textarea'))).toBe(true);
    expect(isEditableTarget(makeEl('select'))).toBe(true);
  });

  it('returns true for contenteditable elements', () => {
    const div = makeEl('div', { contentEditable: 'true' });
    document.body.appendChild(div);
    expect(isEditableTarget(div)).toBe(true);
  });

  it('returns true for descendants of a contenteditable ancestor', () => {
    const parent = makeEl('div', { contentEditable: 'true' });
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);
    expect(isEditableTarget(child)).toBe(true);
  });

  it('returns true for elements opted-in via [data-editable="true"]', () => {
    const wrapper = makeEl('div', { 'data-editable': 'true' });
    const inner = document.createElement('span');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('returns true for role="textbox" wrappers', () => {
    const wrapper = makeEl('div', { role: 'textbox' });
    const inner = document.createElement('span');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    expect(isEditableTarget(inner)).toBe(true);
  });

  it('returns false for plain non-editable elements', () => {
    expect(isEditableTarget(makeEl('div'))).toBe(false);
    expect(isEditableTarget(makeEl('button'))).toBe(false);
    expect(isEditableTarget(makeEl('span'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
  });
});
