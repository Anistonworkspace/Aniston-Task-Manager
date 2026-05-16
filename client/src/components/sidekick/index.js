export { default } from './SidekickPanel';
export { default as SidekickPanel } from './SidekickPanel';
// SidekickFAB removed (Plan A audit, 2026-05-16) — ToolsFAB already serves
// as the visible AI launcher in Layout.jsx. Having a second FAB created
// confusion and never actually mounted. If we ever want a dedicated Sidekick
// FAB separate from the Tools cluster, restore from git history at b645dc8.
export { default as SidekickComposer } from './SidekickComposer';
// Plan A Slice 3 — one-shot AI result UI for inline summaries / priority
// suggestions / week plans. The Sidekick chat panel is for free-form Q&A;
// this popover is for single-shot results consumed inline.
export { default as AISummaryPopover } from './AISummaryPopover';
export { default as SuggestPriorityChip } from './SuggestPriorityChip';
export { default as PlanWeekModal } from './PlanWeekModal';
export { default as SidekickChatThread } from './SidekickChatThread';
export { default as SidekickEmptyState } from './SidekickEmptyState';
export { default as SidekickAIResponse } from './SidekickAIResponse';
export { default as SidekickUserMessage } from './SidekickUserMessage';
export { default as SidekickChatsListRail, readChats, writeChats, deriveChatTitle } from './SidekickChatsListRail';
export { default as SidekickMarkdown } from './SidekickMarkdown';
export { default as SidekickSourcesPopover } from './SidekickSourcesPopover';
export { default as RainbowInputWrapper } from './RainbowInputWrapper';
export { default as ActionSuggestions } from './ActionSuggestions';
export { default as useSidekickChat } from './useSidekickChat';
export { getActionSuggestions } from './actionSuggestionCatalog';
