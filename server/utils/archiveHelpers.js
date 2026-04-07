const PROTECTION_DAYS = 90;

/**
 * Check if a user can permanently delete an archived item.
 * SuperAdmin can always delete. Others must wait 90 days.
 */
function canPermanentlyDelete(user, archivedAt) {
  if (user.isSuperAdmin) return { allowed: true, daysRemaining: 0 };
  if (!archivedAt) return { allowed: true, daysRemaining: 0 }; // legacy items without archivedAt
  const daysSince = Math.floor((Date.now() - new Date(archivedAt).getTime()) / (1000 * 60 * 60 * 24));
  const daysRemaining = Math.max(0, PROTECTION_DAYS - daysSince);
  return { allowed: daysRemaining === 0, daysRemaining };
}

/**
 * Get protection status for display in the UI.
 */
function getProtectionInfo(archivedAt) {
  if (!archivedAt) return { isProtected: false, daysRemaining: 0 };
  const daysSince = Math.floor((Date.now() - new Date(archivedAt).getTime()) / (1000 * 60 * 60 * 24));
  const daysRemaining = Math.max(0, PROTECTION_DAYS - daysSince);
  return { isProtected: daysRemaining > 0, daysRemaining };
}

module.exports = { canPermanentlyDelete, getProtectionInfo, PROTECTION_DAYS };
