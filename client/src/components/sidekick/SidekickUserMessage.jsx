import React from 'react';

/**
 * SidekickUserMessage — the user-authored bubble (skill §5.3).
 *
 * Right-aligned, light-gray rounded bubble. Pure presentation.
 */
export default function SidekickUserMessage({ content }) {
  return (
    <div className="flex justify-end my-2">
      <div
        className="max-w-[80%] px-3 py-2 rounded-2xl rounded-tr-md text-sm text-text-primary leading-relaxed whitespace-pre-wrap break-words"
        style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }}
      >
        {content}
      </div>
    </div>
  );
}
