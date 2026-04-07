import React from 'react';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function ManagerDashboardPage() {
  return (
    <RoleDashboard
      scope="manager"
      title="My Dashboard"
      subtitle="Manager"
      showPersonFilter={true}
      showUnassigned={true}
    />
  );
}
