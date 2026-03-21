import React, { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import OnboardingTour from '../common/OnboardingTour';
import { useAuth } from '../../context/AuthContext';
import { Eye, Shield, Users, User, ChevronUp } from 'lucide-react';

function RoleSwitcher() {
  const { isSuperAdmin, viewAsRole, switchViewAs, effectiveRole } = useAuth();
  const [open, setOpen] = useState(false);

  if (!isSuperAdmin) return null;

  const roles = [
    { key: null, label: 'Admin (Default)', icon: Shield, color: '#e2445c' },
    { key: 'manager', label: 'View as Manager', icon: Users, color: '#0073ea' },
    { key: 'member', label: 'View as Employee', icon: User, color: '#00c875' },
  ];

  const currentLabel = viewAsRole
    ? `Viewing as ${viewAsRole === 'manager' ? 'Manager' : 'Employee'}`
    : 'Super Admin';

  return (
    <div className="fixed bottom-4 right-4 z-[9999]">
      {/* Menu */}
      {open && (
        <div className="absolute bottom-12 right-0 bg-white rounded-xl shadow-2xl border border-gray-200 w-52 py-1.5 mb-1 animate-in fade-in slide-in-from-bottom-2">
          <p className="px-3 py-1 text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Switch View</p>
          {roles.map(r => (
            <button key={r.key || 'default'} onClick={() => { switchViewAs(r.key); setOpen(false); }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-[12px] transition-colors
                ${(viewAsRole === r.key || (!viewAsRole && r.key === null)) ? 'bg-blue-50 text-blue-600 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
              <r.icon size={13} style={{ color: r.color }} />
              {r.label}
            </button>
          ))}
        </div>
      )}

      {/* Toggle button */}
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 px-3 py-2 rounded-full shadow-lg border transition-all text-[11px] font-medium
          ${viewAsRole ? 'bg-orange-500 text-white border-orange-400' : 'bg-gray-900 text-white border-gray-700'}`}>
        <Eye size={13} />
        {currentLabel}
        <ChevronUp size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white dark:bg-[#0c0a1d]">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <main className="flex-1 overflow-auto" key={location.pathname}>
          <div className="page-enter h-full">
            <Outlet />
          </div>
        </main>
      </div>
      <RoleSwitcher />
      <OnboardingTour />
    </div>
  );
}
