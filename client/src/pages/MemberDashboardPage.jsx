import React from 'react';
import { useAuth } from '../context/AuthContext';
import RoleDashboard from '../components/dashboard/RoleDashboard';
import { resolveTier, tierLabel, hasTierAtLeast, TIER_3 } from '../utils/tiers';

export default function MemberDashboardPage() {
  const { user } = useAuth();

  // Tier 1/Tier 2/Tier 3 actors see all tasks with the person filter; Tier 4
  // sees only their own. (Was: SuperAdmin/Asst Mgr/Admin/Manager fan-in.)
  const canSeeAll = hasTierAtLeast(user, TIER_3);

  return (
    <RoleDashboard
      scope={canSeeAll ? 'admin' : 'member'}
      title="My Dashboard"
      subtitle={tierLabel(resolveTier(user))}
      showPersonFilter={canSeeAll}
      showUnassigned={canSeeAll}
    />
  );
}
