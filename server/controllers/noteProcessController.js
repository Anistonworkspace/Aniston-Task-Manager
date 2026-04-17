const aiService = require('../services/aiService');
const { sanitizeInput } = require('../utils/sanitize');

/**
 * Processing type → system prompt mapping.
 * Each prompt is tuned for a specific kind of transcript enhancement.
 */
const PROCESS_PROMPTS = {
  clean: `You are a transcript editor. The user will give you a raw voice-to-text transcript.
Clean it up:
- Fix grammar, punctuation, and capitalization
- Remove filler words (um, uh, like, you know)
- Remove duplicate/repeated phrases
- Preserve the original meaning and tone
- Keep it in the same language as the input
Return ONLY the cleaned transcript, no commentary.`,

  summarize: `You are a summarization assistant. The user will give you a voice transcript.
Produce a concise summary:
- Extract the key points (bulleted list)
- Keep it under 30% of the original length
- Highlight any decisions or conclusions mentioned
- Use clear, professional language
Return ONLY the summary, no commentary.`,

  action_items: `You are a meeting assistant. The user will give you a voice transcript.
Extract action items and decisions:
- List each action item with the responsible person (if mentioned)
- Note deadlines or timeframes if mentioned
- List any decisions that were made
- List any open questions or follow-ups needed
Format as:
## Action Items
- [ ] Action item description (@person, by deadline)

## Decisions
- Decision made

## Follow-ups
- Question or topic needing follow-up

Return ONLY the structured output, no commentary.`,

  meeting_notes: `You are a meeting notes assistant. The user will give you a raw voice transcript from a meeting.
Format it as professional meeting notes:
- Add a brief summary at the top (2-3 sentences)
- Organize by topics discussed
- Within each topic, note key points and any decisions
- End with action items and next steps
- Fix any grammar or transcription errors
- If speaker labels are present (e.g. [Speaker 1]:), preserve them
Return ONLY the formatted meeting notes, no commentary.`,
};

/**
 * POST /api/notes/process
 * Send transcript text to the configured AI provider for processing.
 *
 * Body: { text: string, processType: 'clean'|'summarize'|'action_items'|'meeting_notes', providerId?: string }
 * Returns: { success: true, data: { result: string, processType: string } }
 */
exports.processTranscript = async (req, res) => {
  try {
    const { text, processType, providerId } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Transcript text is required.' });
    }

    if (!processType || !PROCESS_PROMPTS[processType]) {
      return res.status(400).json({
        success: false,
        message: `Invalid processType. Must be one of: ${Object.keys(PROCESS_PROMPTS).join(', ')}`,
      });
    }

    // Truncate extremely long transcripts to avoid token limits
    const maxChars = 15000;
    const sanitized = sanitizeInput(text.trim());
    const truncated = sanitized.length > maxChars
      ? sanitized.substring(0, maxChars) + '\n\n[Transcript truncated due to length]'
      : sanitized;

    const systemPrompt = PROCESS_PROMPTS[processType];
    const messages = [{ role: 'user', content: truncated }];

    const result = await aiService.chat(messages, systemPrompt, providerId || undefined);

    res.json({
      success: true,
      data: {
        result,
        processType,
        originalLength: text.length,
        processedLength: result.length,
      },
    });
  } catch (err) {
    console.error('[NoteProcessController] processTranscript error:', err.message);

    // Provide helpful error messages based on the failure type
    const provInfo = err._providerInfo;
    if (provInfo) {
      return res.status(502).json({
        success: false,
        message: `AI processing failed using ${provInfo.displayName} (${provInfo.model}). ${err.message}`,
        provider: provInfo.displayName,
      });
    }

    if (err.message?.includes('not configured')) {
      return res.status(503).json({
        success: false,
        message: 'AI is not configured. An admin must set up an AI provider in Integrations before transcript processing can work.',
      });
    }

    res.status(500).json({ success: false, message: 'Failed to process transcript. Please try again.' });
  }
};

/**
 * GET /api/notes/process/types
 * Return available processing types for the frontend to display.
 */
exports.getProcessTypes = async (_req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'clean', label: 'Clean Transcript', description: 'Fix grammar, remove filler words and repetition', icon: 'sparkles' },
      { id: 'summarize', label: 'Summarize', description: 'Extract key points into a concise summary', icon: 'list' },
      { id: 'action_items', label: 'Action Items', description: 'Extract tasks, decisions, and follow-ups', icon: 'check-square' },
      { id: 'meeting_notes', label: 'Meeting Notes', description: 'Format as professional meeting notes', icon: 'file-text' },
    ],
  });
};
