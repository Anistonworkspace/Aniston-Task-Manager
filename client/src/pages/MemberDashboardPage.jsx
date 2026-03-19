import React from 'react';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function MemberDashboardPage() {
  return (
    <RoleDashboard
      scope="member"
      title="My Dashboard"
      subtitle="Member"
      showPersonFilter={false}
      showUnassigned={false}
    />
  );
}
