import React, { useState, useRef } from 'react';
import { Check } from 'lucide-react';
import { PRIORITY_CONFIG } from '../../utils/constants';
import PortalDropdown from '../common/PortalDropdown';

export default function PriorityCell({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);

  const config = PRIORITY_CONFIG[value];

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="status-pill w-full" style={{ backgroundColor: config ? config.bgColor : '#94a3b8' }}>
        {config ? config.label : 'None'}
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={160} align="center">
        <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-dropdown border border-border dark:border-[#2d2b45] p-1.5">
          {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
            <button key={key} onClick={(e) => { e.stopPropagation(); onChange(key); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors mb-0.5 ${value === key ? 'bg-surface-100' : 'hover:bg-surface-50'}`}>
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cfg.bgColor }} />
              <span className="text-text-primary font-medium flex-1 text-left">{cfg.label}</span>
              {value === key && <Check size={12} className="text-primary-500" />}
            </button>
          ))}
        </div>
      </PortalDropdown>
    </div>
  );
}
