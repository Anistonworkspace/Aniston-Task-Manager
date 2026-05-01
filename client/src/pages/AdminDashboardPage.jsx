import React from 'react';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function AdminDashboardPage() {
  return (
    <RoleDashboard
      scope="admin"
      title="My Dashboard"
      subtitle="Admin"
      showPersonFilter={true}
      showUnassigned={true}
    />
  );
}
