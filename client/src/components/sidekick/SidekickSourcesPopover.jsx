import React from 'react';
import { ExternalLink, BookOpen } from 'lucide-react';
import Popover from '../common/Popover';

/**
 * SidekickSourcesPopover — citations button + dropdown (skill §5.5).
 *
 *   <SidekickSourcesPopover sources={[{title, url, domain, favicon}]} />
 *
 * Renders nothing if `sources` is empty. Anchored to the bottom-right of the
 * AI response card; clicking opens the scrollable citation list.
 */
export default function SidekickSourcesPopover({ sources = [] }) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  return (
    <Popover placement="top-end" offset={4}>
      <Popover.Trigger>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-text-secondary bg-surface-100 hover:bg-surface-200 transition-colors"
        >
          <BookOpen size={12} />
          {sources.length} {sources.length === 1 ? 'Source' : 'Sources'}
        </button>
      </Popover.Trigger>
      <Popover.Content width={320} maxHeight={360} ariaLabel="Cited sources">
        <div
          className="rounded-md shadow-md overflow-hidden"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
          }}
        >
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary border-b border-border-light">
            Sources ({sources.length})
          </div>
          <ul className="max-h-80 overflow-auto py-1">
            {sources.map((s, i) => (
              <li key={`${s.url || s.title}-${i}`}>
                <a
                  href={s.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2.5 px-3 py-2 hover:bg-surface-100 transition-colors"
                >
                  {s.favicon ? (
                    <img src={s.favicon} alt="" width={20} height={20} className="rounded-sm flex-shrink-0 mt-0.5" />
                  ) : (
                    <ExternalLink size={14} className="text-text-tertiary flex-shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {s.title || s.url}
                    </div>
                    {(s.domain || s.url) && (
                      <div className="text-xs text-text-tertiary truncate">
                        {s.domain || extractDomain(s.url)}
                      </div>
                    )}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Popover.Content>
    </Popover>
  );
}

function extractDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
