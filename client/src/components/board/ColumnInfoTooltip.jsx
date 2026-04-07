import React, { useState, useRef } from 'react';
import { Info } from 'lucide-react';
import PortalDropdown from '../common/PortalDropdown';

const COLUMN_DESCRIPTIONS = {
  status: {
    title: 'Deadline mode',
    desc: 'This "Status" is connected to "Due date" column, so its color reflects each task\'s current status.',
    action: "Clear 'deadline mode'",
  },
  person: { title: 'Owner', desc: 'Assign team members to this task. Multiple owners can be assigned.' },
  date: { title: 'Due Date', desc: 'Set the deadline for this task. Overdue tasks will be highlighted.' },
  priority: { title: 'Priority', desc: 'Set the priority level: Low, Medium, High, or Critical.' },
  progress: { title: 'Progress', desc: 'Track task completion percentage from 0% to 100%.' },
  label: { title: 'Labels', desc: 'Add colored labels/tags to categorize tasks.' },
  text: { title: 'Text Column', desc: 'A single line text field for additional information.' },
  number: { title: 'Number Column', desc: 'A numeric field for values like budget, hours, etc.' },
  checkbox: { title: 'Checkbox', desc: 'A simple yes/no toggle field.' },
  link: { title: 'Link', desc: 'Add URLs and web links to tasks.' },
};

export default function ColumnInfoTooltip({ column }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const info = COLUMN_DESCRIPTIONS[column.type] || { title: column.title, desc: 'Custom column field.' };

  return (
    <>
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="opacity-0 group-hover/col:opacity-100 p-0.5 rounded hover:bg-[#dcdfec] text-[#c4c4c4] hover:text-[#676879] transition-all">
        <Info size={11} />
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={260} align="center">
        <div className="bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] p-4">
          <div className="flex items-center gap-2 mb-2">
            {column.type === 'status' && (
              <div className="w-6 h-6 rounded-full bg-[#fdab3d]/10 flex items-center justify-center">
                <span className="text-[#fdab3d] text-xs">✓</span>
              </div>
            )}
            <h4 className="text-[13px] font-semibold text-[#323338]">{info.title}</h4>
          </div>
          <p className="text-[12px] text-[#676879] leading-relaxed">{info.desc}</p>
          {info.action && (
            <button className="mt-3 px-3 py-1.5 text-[12px] text-[#0073ea] border border-[#0073ea]/30 rounded hover:bg-[#0073ea]/5 transition-colors">
              {info.action}
            </button>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
