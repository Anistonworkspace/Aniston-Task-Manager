import React, { useState } from 'react';
import { LABEL_PALETTE, hashToPaletteToken, resolvePaletteColor } from '../../../utils/labelPalette';

/**
 * LetterAvatar — colored letter representation of an entity.
 *
 *   <LetterAvatar name="Inbound Sales" shape="square" size="md" />
 *   <LetterAvatar name="John Smith" shape="circle" size="sm" />
 *   <LetterAvatar name="Marketing" color="purple" shape="square" />
 *   <LetterAvatar image="/u/123.png" name="John Smith" />
 *
 * - shape "square" (default, used for workspaces/groups/accounts)
 *   "circle" (used for people)
 * - color override (palette token or hex). When omitted, color is hashed
 *   from the name so the same name always renders the same color.
 * - image: when provided, shows the image; falls back to letter on error.
 */
const SIZE_TOKENS = {
  xs: { box: 20, font: 9, gap: 'w-5 h-5 text-[9px]' },
  sm: { box: 24, font: 10, gap: 'w-6 h-6 text-[10px]' },
  md: { box: 32, font: 12, gap: 'w-8 h-8 text-xs' },
  lg: { box: 40, font: 13, gap: 'w-10 h-10 text-sm' },
  xl: { box: 56, font: 18, gap: 'w-14 h-14 text-lg' },
};

function getInitial(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed[0].toUpperCase();
}

function getInitials(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function LetterAvatar({
  name,
  image,
  color,
  size = 'md',
  shape = 'square',
  className = '',
  initials = 'single',
  title,
}) {
  const [imgError, setImgError] = useState(false);
  const tok = SIZE_TOKENS[size] || SIZE_TOKENS.md;
  const paletteToken = color || hashToPaletteToken(name);
  const palette = resolvePaletteColor(paletteToken);

  const showImage = image && !imgError;
  const radius = shape === 'circle' ? '50%' : '6px';
  const label = initials === 'double' ? getInitials(name) : getInitial(name);

  return (
    <div
      className={`flex items-center justify-center font-semibold flex-shrink-0 select-none ${className}`}
      style={{
        width: tok.box,
        height: tok.box,
        fontSize: tok.font,
        borderRadius: radius,
        backgroundColor: showImage ? 'transparent' : palette.bg,
        color: palette.text || '#fff',
      }}
      title={title || name}
      aria-label={title || name || 'Avatar'}
    >
      {showImage ? (
        <img
          src={image}
          alt={name || ''}
          className="w-full h-full object-cover"
          style={{ borderRadius: radius }}
          onError={() => setImgError(true)}
        />
      ) : label}
    </div>
  );
}

LetterAvatar.PALETTE = LABEL_PALETTE;
