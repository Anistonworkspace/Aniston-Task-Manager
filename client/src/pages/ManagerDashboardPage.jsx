import React from 'react';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function ManagerDashboardPage() {
  return (
    <RoleDashboard
      scope="manager"
      title="My Dashboard"
      subtitle="Tier 2"
      showPersonFilter={true}
      showUnassigned={true}
    />
  );
}
