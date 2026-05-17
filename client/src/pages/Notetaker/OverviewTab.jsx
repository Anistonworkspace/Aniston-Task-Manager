import React, { useState } from 'react';
import { Pencil, Copy, ChevronDown, Sparkles, FileText, Check } from 'lucide-react';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';
import Popover from '../../components/common/Popover';

/**
 * OverviewTab — left-column tab on the meeting detail page (skill §7).
 *
 *   <OverviewTab meeting={meeting} transcriptStatus="unavailable" />
 *
 * Shows the AI-generated summary card. When the meeting hasn't been recorded
 * yet (transcriptStatus !== 'ok'), the card renders an honest empty state
 * explaining the transcript pipeline is required for summary generation.
 *
 * The summary content is purely backend-driven; this component just renders
 * markdown-ish text. Editing the summary is a separate slice.
 */

const SUMMARY_TEMPLATES = [
  { id: 'general',         label: 'General summary' },
  { id: 'action_items',    label: 'Action items focused' },
  { id: 'decision_log',    label: 'Decision log' },
  { id: 'customer_call',   label: 'Customer call' },
  { id: 'team_retro',      label: 'Team retrospective' },
];

export default function OverviewTab({
  meeting,
  transcriptStatus = 'idle',
}) {
  const toast = useToast();
  const [template, setTemplate] = useState('general');
  const [copied, setCopied] = useState(false);
  const summary = meeting?.summary || meeting?.aiSummary;

  async function handleCopy() {
    const text = formatSummaryForCopy(meeting, summary, template);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  }

  const hasSummary = !!(summary && String(summary).trim());

  return (
    <div className="space-y-3">
      <SummaryCard
        template={template}
        onTemplateChange={setTemplate}
        onCopy={handleCopy}
        copied={copied}
        hasSummary={hasSummary}
      >
        {hasSummary ? (
          <article className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
            {summary}
          </article>
        ) : (
          <SummaryEmptyState transcriptStatus={transcriptStatus} />
        )}
      </SummaryCard>
    </div>
  );
}

function SummaryCard({ template, onTemplateChange, onCopy, copied, hasSummary, children }) {
  const currentLabel = SUMMARY_TEMPLATES.find((t) => t.id === template)?.label || 'General summary';
  return (
    <div
      className="rounded-md bg-surface overflow-hidden"
      style={{
        border: '1px solid var(--layout-border-color, #e2e2e2)',
        borderLeft: '3px solid #ff158a', // signature coral/pink left-border (skill §7.3)
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-light">
        <Pencil size={13} className="text-text-secondary flex-shrink-0" />
        <div className="text-xs font-semibold text-text-primary flex-1 truncate">
          {currentLabel}
        </div>

        <SummaryTemplatePicker template={template} onChange={onTemplateChange} />

        <button
          type="button"
          onClick={onCopy}
          disabled={!hasSummary}
          aria-label="Copy summary"
          className="p-1 rounded text-text-tertiary hover:bg-surface-100 disabled:opacity-30"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className="px-4 py-3">
        {children}
      </div>
    </div>
  );
}

function SummaryTemplatePicker({ template, onChange }) {
  const currentLabel = SUMMARY_TEMPLATES.find((t) => t.id === template)?.label || 'Template';
  return (
    <Popover placement="bottom-end" offset={4}>
      <Popover.Trigger>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-text-secondary hover:bg-surface-100"
        >
          Summary templates
          <ChevronDown size={11} />
        </button>
      </Popover.Trigger>
      <Popover.Content width={200} ariaLabel="Summary templates">
        <div
          className="rounded-md shadow-md py-1"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
          }}
        >
          {SUMMARY_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange?.(t.id)}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                template === t.id
                  ? 'bg-primary-50 text-primary font-semibold'
                  : 'text-text-primary hover:bg-surface-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Popover.Content>
    </Popover>
  );
}

function SummaryEmptyState({ transcriptStatus }) {
  if (transcriptStatus === 'loading') {
    return (
      <div className="py-4 text-sm text-text-secondary flex items-center gap-2">
        <Sparkles size={14} className="text-primary animate-pulse" />
        Looking for transcript…
      </div>
    );
  }
  return (
    <EmptyState
      compact
      icon={<FileText size={36} className="text-text-tertiary" />}
      title={transcriptStatus === 'error' ? 'Summary unavailable' : 'No summary yet'}
      description={transcriptStatus === 'unavailable'
        ? "This meeting hasn't been recorded. Invite AI Notetaker to a future meeting to get an automatic summary."
        : 'Once the meeting is recorded, an AI summary will appear here.'}
    />
  );
}

function formatSummaryForCopy(meeting, summary, template) {
  const lines = [
    meeting?.title || 'Meeting summary',
    `Template: ${template}`,
    '',
    summary || '(No summary available yet.)',
  ];
  return lines.join('\n');
}
