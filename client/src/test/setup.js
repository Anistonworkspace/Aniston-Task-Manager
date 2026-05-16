import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Doc Editor Phase A — Tiptap's BubbleMenu uses tippy.js, whose default
// export only resolves correctly in real browsers. In jsdom + ESM,
// the plugin throws "tippy is not a function" the moment a transaction
// dispatches. Stub the BubbleMenu component globally so any test that
// renders RichTextEditor (or anything that embeds it) mounts cleanly.
// Production usage is unaffected — Vite's bundler resolves tippy fine.
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, BubbleMenu: () => null };
});

// Mock IntersectionObserver
class IntersectionObserver {
  constructor() {}
  observe() { return null; }
  unobserve() { return null; }
  disconnect() { return null; }
}
window.IntersectionObserver = IntersectionObserver;

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// Mock ResizeObserver
class ResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserver;

// Mock scrollTo
window.scrollTo = () => {};

// Suppress console.error in tests for cleaner output
const originalError = console.error;
console.error = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('Warning: ReactDOM.render is no longer supported') ||
      args[0].includes('act(...)'))
  ) {
    return;
  }
  originalError.call(console, ...args);
};
