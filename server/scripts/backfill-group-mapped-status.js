/**
 * Migration — backfill `mappedStatus` on each Board.groups[] entry.
 *
 * Boards created before the explicit status↔group mapping feature have groups
 * shaped like `{ id, title, color, position }` with no mappedStatus. This
 * script infers a mapping by reusing the same id/regex logic the runtime uses
 * (`findGroupForStatus` reversed) so existing boards behave like newly-created
 * ones without forcing the user to re-pick mappings by hand.
 *
 * Groups whose title doesn't fit any known status (e.g. "Backlog Q3", "Acme
 * Corp") are left without a mapping — which is the intended behavior: the
 * runtime treats "no mapping" as "don't auto-move," so domain-specific groups
 * (CRM stages, sprint slots, etc.) remain drag-only.
 *
 * Idempotent: groups that already have a mappedStatus are not touched.
 *
 * Run:
 *   node server/scripts/backfill-group-mapped-status.js
 *
 * Dry-run (logs intended changes, writes nothing):
 *   node server/scripts/backfill-group-mapped-status.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
const Board = require('../models/Board');

const DRY_RUN = process.argv.includes('--dry-run');

// Inverse of STATUS_GROUP_MAP in utils/taskPrioritization.js. Each entry
// proposes a status when the group title matches the regex. Order matters —
// more specific patterns first so "stuck" doesn't fall through to "in_progress".
const TITLE_TO_STATUS = [
  { pattern: /done|complet|finish|closed/i,           status: 'done' },
  { pattern: /stuck|block/i,                          status: 'stuck' },
  { pattern: /review|qa|test|verify/i,                status: 'review' },
  { pattern: /progress|working|active|doing|started/i, status: 'working_on_it' },
  { pattern: /to.?do|not.?started|new|backlog|pending|todo|ready/i, status: 'not_started' },
];

// Group ids that are themselves valid status values — short-circuit by id.
const ID_TO_STATUS = {
  not_started: 'not_started',
  new: 'not_started',
  working_on_it: 'working_on_it',
  in_progress: 'working_on_it',
  stuck: 'stuck',
  review: 'review',
  done: 'done',
  completed: 'done',
  closed: 'done',
};

function inferStatus(group) {
  if (!group || typeof group !== 'object') return null;
  const id = String(group.id || '').toLowerCase().trim();
  if (ID_TO_STATUS[id]) return ID_TO_STATUS[id];
  const title = String(group.title || group.name || '');
  for (const { pattern, status } of TITLE_TO_STATUS) {
    if (pattern.test(title)) return status;
  }
  return null;
}

(async () => {
  try {
    await sequelize.authenticate();
    console.log(`[backfill-group-mapped-status] Connected (dry-run=${DRY_RUN}).`);

    const boards = await Board.findAll({ attributes: ['id', 'name', 'groups'] });
    console.log(`[backfill-group-mapped-status] Scanning ${boards.length} boards.`);

    let touchedBoards = 0;
    let touchedGroups = 0;

    for (const board of boards) {
      if (!Array.isArray(board.groups) || board.groups.length === 0) continue;

      let changed = false;
      const next = board.groups.map((g) => {
        if (g && g.mappedStatus) return g; // already mapped, leave alone
        const inferred = inferStatus(g);
        if (!inferred) return g;
        changed = true;
        touchedGroups++;
        return { ...g, mappedStatus: inferred };
      });

      if (!changed) continue;

      console.log(
        `[backfill-group-mapped-status] Board "${board.name}" (${board.id}) — ${
          next.filter((g, i) => g.mappedStatus !== board.groups[i]?.mappedStatus).length
        } group(s) updated.`
      );

      if (!DRY_RUN) {
        // changed:true on the JSONB field is required for Sequelize to persist
        // an in-place mutation. Reassign + .save() to be explicit.
        board.groups = next;
        board.changed('groups', true);
        await board.save();
      }
      touchedBoards++;
    }

    console.log(
      `[backfill-group-mapped-status] Done. Boards updated: ${touchedBoards}, groups updated: ${touchedGroups}.`
    );
    if (DRY_RUN) console.log('[backfill-group-mapped-status] (dry run — nothing written)');
    process.exit(0);
  } catch (err) {
    console.error('[backfill-group-mapped-status] Failed:', err);
    process.exit(1);
  }
})();
