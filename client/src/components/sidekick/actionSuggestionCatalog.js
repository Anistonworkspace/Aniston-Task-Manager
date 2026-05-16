import {
  HelpCircle, Mail, ArrowRight, Eye, ListChecks, FileText, BookOpen, Languages,
  Sparkles, LayoutGrid, Target, Compass, BarChart3, Flag, Calendar, AlertTriangle,
  Clock, ListOrdered, Brain,
} from 'lucide-react';

/**
 * Catalog of scoped Sidekick action suggestions (skill §7.4–7.6).
 *
 *   getActionSuggestions('meeting')  →  meeting prompt chips
 *   getActionSuggestions('doc')      →  doc prompt chips
 *   getActionSuggestions('board')    →  board prompt chips
 *
 * Returning an empty array is intentional for unknown scopes — the
 * ActionSuggestions component renders nothing in that case.
 */

const CATALOG = {
  meeting: [
    { id: 'about',        label: 'What was this meeting about?', icon: HelpCircle },
    { id: 'follow_email', label: "Generate this meeting's follow-up email", icon: Mail },
    { id: 'next_steps',   label: 'What are the next steps?', icon: ArrowRight },
    { id: 'missed',       label: 'What should I know if I missed this meeting?', icon: Eye },
    { id: 'actions',      label: 'What are the action items?', icon: ListChecks },
  ],
  doc: [
    { id: 'summarize', label: 'Summarize this doc', icon: FileText },
    { id: 'keypoints', label: 'Extract the key points', icon: BookOpen },
    { id: 'rewrite',   label: 'Rewrite for clarity', icon: Sparkles },
    { id: 'translate', label: 'Translate to another language', icon: Languages },
  ],
  board: [
    { id: 'status',    label: "What's the status of this board?", icon: LayoutGrid },
    { id: 'overdue',   label: 'What items are overdue?', icon: Target },
    { id: 'behind',    label: 'Where are we behind?', icon: Compass },
    { id: 'stuck',     label: 'Which tasks are stuck and why?', icon: AlertTriangle },
    { id: 'summary',   label: 'Create a summary report', icon: BarChart3 },
  ],
  // Plan A Slice 1: scoped Sidekick on a single task. Powers the "Ask AI"
  // button in TaskModal — see useSidekickChat({ scope:'task', scopeId }).
  task: [
    { id: 'summary',   label: 'Summarize this task', icon: FileText },
    { id: 'blocked',   label: 'Why is this task blocked?', icon: AlertTriangle },
    { id: 'next',      label: 'What are the next steps?', icon: ArrowRight },
    { id: 'priority',  label: 'Should I bump up the priority?', icon: Flag },
    { id: 'duedate',   label: 'Is the due date realistic?', icon: Calendar },
  ],
  // Plan A Slice 1: scoped Sidekick on the caller's own workload. Powers the
  // "Plan my week" / "Suggest order for today" buttons on MyWorkPage.
  planning: [
    { id: 'today',     label: 'Suggest the order I should do today', icon: ListOrdered },
    { id: 'week',      label: 'Plan my week based on these tasks', icon: Calendar },
    { id: 'focus',     label: 'What should I focus on first?', icon: Target },
    { id: 'overload',  label: 'Am I overloaded for this week?', icon: AlertTriangle },
    { id: 'time',      label: 'Roughly how long will this all take?', icon: Clock },
    { id: 'why',       label: 'Why did you order it this way?', icon: Brain },
  ],
};

export function getActionSuggestions(scope) {
  return CATALOG[scope] || [];
}
