import React from 'react';
import Avatar from '../common/Avatar';

const AVATAR_PX = { xs: 24, sm: 28, md: 32, lg: 40, xl: 48 };

/**
 * Overlapping avatar stack.
 *
 * - When `empty` is true (or no users provided), renders dashed gray
 *   placeholder circles with no initials. Reads as "no data yet" rather
 *   than "fake users".
 */
export default function AvatarStack({ users = [], empty = false, max = 3, size = 'sm' }) {
  const isEmpty = empty || users.length === 0;
  const px = AVATAR_PX[size] ?? AVATAR_PX.sm;

  if (isEmpty) {
    return (
      <div
        className="flex items-center"
        aria-hidden="true"
        role="presentation"
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <span
            key={i}
            className="rounded-full border border-dashed border-text-tertiary/40 bg-transparent ring-2 ring-white dark:ring-[var(--bg-elevated)]"
            style={{
              width: px,
              height: px,
              marginLeft: i === 0 ? 0 : -8,
            }}
          />
        ))}
      </div>
    );
  }

  const visible = users.slice(0, max);
  const remaining = users.length - visible.length;

  return (
    <div className="flex items-center">
      {visible.map((u, i) => (
        <div
          key={u.id || i}
          className="rounded-full ring-2 ring-white dark:ring-[var(--bg-elevated)]"
          style={{ marginLeft: i === 0 ? 0 : -8 }}
        >
          <Avatar name={u.name} image={u.avatar} size={size} />
        </div>
      ))}
      {remaining > 0 && (
        <span
          className="ml-[-8px] inline-flex items-center justify-center rounded-full bg-surface-100 text-text-secondary text-[10px] font-semibold ring-2 ring-white dark:ring-[var(--bg-elevated)]"
          style={{ width: px, height: px }}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
}
