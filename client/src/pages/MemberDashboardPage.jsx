import React from 'react';
import { useAuth } from '../context/AuthContext';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function MemberDashboardPage() {
  const { isSuperAdmin, isAssistantManager, isAdmin, isManager } = useAuth();

  // SuperAdmin and Assistant Manager see all tasks with person filter
  // Admin and Manager also see all tasks with person filter
  // Regular members see only their own tasks
  const canSeeAll = isSuperAdmin || isAssistantManager || isAdmin || isManager;

  return (
    <RoleDashboard
      scope={canSeeAll ? 'admin' : 'member'}
      title="My Dashboard"
      subtitle={isSuperAdmin ? 'Super Admin' : isAssistantManager ? 'Assistant Manager' : isAdmin ? 'Admin' : isManager ? 'Manager' : 'Member'}
      showPersonFilter={canSeeAll}
      showUnassigned={canSeeAll}
    />
  );
}
