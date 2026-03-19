import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye } from 'lucide-react';
import RoleDashboard from '../components/dashboard/RoleDashboard';

export default function AdminDashboardPage() {
  const navigate = useNavigate();

  return (
    <div>
      {/* Quick links to other dashboards */}
      <div className="px-6 pt-4 flex items-center gap-2">
        <button onClick={() => navigate('/manager-dashboard')}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-surface transition-colors text-text-secondary">
          <Eye size={12} /> View as Manager
        </button>
        <button onClick={() => navigate('/member-dashboard')}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-surface transition-colors text-text-secondary">
          <Eye size={12} /> View as Member
        </button>
      </div>
      <RoleDashboard
        scope="admin"
        title="My Dashboard"
        subtitle="Admin"
        showPersonFilter={true}
        showUnassigned={true}
      />
    </div>
  );
}
