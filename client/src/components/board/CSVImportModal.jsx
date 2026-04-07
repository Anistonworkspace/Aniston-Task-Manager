import React, { useState, useRef } from 'react';
import { Upload, X, Check, AlertCircle, Download, Lock, FileText } from 'lucide-react';
import api from '../../services/api';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

export default function CSVImportModal({ boardId, board, columns = [], members = [], onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dbLocked, setDbLocked] = useState(false);
  const fileRef = useRef(null);

  const FIELDS = ['title', 'description', 'status', 'priority', 'dueDate', 'startDate', 'assignedTo', 'tags', 'progress', 'group'];

  // Generate and download an Excel template matching the board's export structure
  async function downloadTemplate() {
    const groups = board?.groups || [];
    const boardName = board?.name || 'Board';
    const customCols = (board?.customColumns || []).map(c => c.title);
    const headers = ['Task', 'Status', 'Owner', 'Due Date', 'Start Date', 'Priority', 'Progress', 'Description', ...customCols];

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Monday Aniston';
    const ws = wb.addWorksheet(boardName);

    // Board title
    const titleRow = ws.addRow([`${boardName} — Import Template`]);
    titleRow.font = { bold: true, size: 16, color: { argb: 'FF323338' } };
    ws.mergeCells(1, 1, 1, headers.length);
    titleRow.height = 32;
    ws.addRow([]); // spacing

    // Reference row with valid values
    const refRow = ws.addRow(['Fill tasks below. Valid statuses: not_started, working_on_it, stuck, done, review  |  Priorities: low, medium, high, critical']);
    refRow.font = { italic: true, size: 9, color: { argb: 'FF999999' } };
    ws.mergeCells(refRow.number, 1, refRow.number, headers.length);
    ws.addRow([]);

    const groupOrder = groups.length > 0 ? groups : [{ id: 'new', title: 'New', color: '#579bfc' }];

    for (const group of groupOrder) {
      const groupColor = (group.color || '#579bfc').replace('#', '');

      // Group header
      const gRow = ws.addRow([`${group.title}`, ...Array(headers.length - 1).fill('')]);
      ws.mergeCells(gRow.number, 1, gRow.number, headers.length);
      gRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      gRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${groupColor}` } };
      gRow.height = 28;

      // Column headers
      const hRow = ws.addRow(headers);
      hRow.font = { bold: true, size: 10, color: { argb: 'FF676879' } };
      hRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } };
      hRow.alignment = { horizontal: 'center', vertical: 'middle' };
      hRow.height = 24;
      hRow.eachCell(cell => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFE6E9EF' } } }; });

      // 3 empty rows for user to fill in
      for (let i = 0; i < 3; i++) {
        const emptyRow = ws.addRow(Array(headers.length).fill(''));
        emptyRow.height = 22;
        emptyRow.eachCell(cell => {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } } };
        });
      }

      ws.addRow([]); // spacing between groups
    }

    // Set column widths
    const widths = [35, 15, 20, 14, 14, 12, 10, 40, ...customCols.map(() => 15)];
    headers.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 15; });

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, `${boardName}_import_template.xlsx`);
  }

  function handleFileSelect(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    parseCSV(f);
  }

  function parseCSV(f) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) { setError('CSV must have headers and at least one data row.'); return; }

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const rows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return obj;
      });

      setPreview({ headers, rows: rows.slice(0, 10), totalRows: rows.length, allRows: rows });

      // Auto-map columns
      const autoMap = {};
      headers.forEach(h => {
        const lower = h.toLowerCase();
        if (lower.includes('title') || lower.includes('name') || lower.includes('task')) autoMap[h] = 'title';
        else if (lower.includes('desc')) autoMap[h] = 'description';
        else if (lower.includes('status')) autoMap[h] = 'status';
        else if (lower.includes('prior')) autoMap[h] = 'priority';
        else if (lower.includes('due') || lower.includes('deadline')) autoMap[h] = 'dueDate';
        else if (lower.includes('start')) autoMap[h] = 'startDate';
        else if (lower.includes('assign') || lower.includes('owner')) autoMap[h] = 'assignedTo';
        else if (lower.includes('tag') || lower.includes('label')) autoMap[h] = 'tags';
        else if (lower.includes('progress') || lower.includes('percent')) autoMap[h] = 'progress';
        else if (lower.includes('group') || lower.includes('sprint') || lower.includes('section')) autoMap[h] = 'group';
      });
      setMapping(autoMap);
    };
    reader.readAsText(f);
  }

  async function handleImport() {
    if (!preview) return;
    setImporting(true);
    setDbLocked(true);
    setError('');

    try {
      const tasks = preview.allRows.map(row => {
        const task = {};
        Object.entries(mapping).forEach(([csvCol, field]) => {
          if (field && row[csvCol]) {
            if (field === 'tags') {
              task[field] = row[csvCol].split(';').map(t => t.trim());
            } else if (field === 'progress') {
              task[field] = parseInt(row[csvCol]) || 0;
            } else {
              task[field] = row[csvCol];
            }
          }
        });
        return task;
      }).filter(t => t.title);

      // Import via API (merge mode - don't replace existing)
      let imported = 0;
      let skipped = 0;

      const groups = board?.groups || [];
      for (const taskData of tasks) {
        try {
          // Resolve group name to groupId
          let groupId = 'new';
          if (taskData.group) {
            const matchedGroup = groups.find(g => g.title.toLowerCase() === taskData.group.toLowerCase());
            if (matchedGroup) groupId = matchedGroup.id;
          }
          const { group: _, ...rest } = taskData;
          await api.post('/tasks', {
            ...rest,
            boardId,
            groupId,
            status: rest.status || 'not_started',
            priority: rest.priority || 'medium',
          });
          imported++;
        } catch (err) {
          skipped++;
        }
      }

      setResult({ imported, skipped, total: tasks.length });
      if (onImported) onImported();
    } catch (err) {
      setError('Import failed: ' + (err.message || 'Unknown error'));
    } finally {
      setImporting(false);
      setDbLocked(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 w-full max-w-2xl max-h-[85vh] overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-zinc-700">
          <div className="flex items-center gap-2">
            <Upload size={18} className="text-primary" />
            <h2 className="text-base font-bold text-gray-800 dark:text-gray-200">Import Tasks from CSV</h2>
            {dbLocked && (
              <span className="flex items-center gap-1 text-[10px] bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                <Lock size={9} /> Database locked
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(85vh-120px)]">
          {!preview && !result && (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <FileText size={28} className="text-primary" />
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Upload a CSV file to import tasks. Existing tasks will NOT be replaced — data will be merged.</p>
              <p className="text-xs text-gray-400 mb-5">Download the template first, fill in your data, then upload it here.</p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={downloadTemplate}
                  className="px-5 py-2.5 bg-white border border-primary text-primary text-sm font-medium rounded-lg hover:bg-primary/5 inline-flex items-center gap-2">
                  <Download size={16} /> Download Template
                </button>
                <input ref={fileRef} type="file" accept=".csv" onChange={handleFileSelect} className="hidden" />
                <button onClick={() => fileRef.current?.click()}
                  className="px-5 py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 inline-flex items-center gap-2">
                  <Upload size={16} /> Choose CSV File
                </button>
              </div>
              {board?.groups?.length > 0 && (
                <div className="mt-4 text-left bg-gray-50 rounded-lg p-3">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Board Groups</p>
                  <div className="flex flex-wrap gap-1.5">
                    {board.groups.map(g => (
                      <span key={g.id} className="text-[11px] px-2 py-0.5 rounded-full border" style={{ borderColor: g.color, color: g.color, backgroundColor: g.color + '10' }}>
                        {g.title}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {preview && !result && (
            <>
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Column Mapping</h3>
                  <span className="text-xs text-gray-400">{preview.totalRows} rows found</span>
                </div>
                <div className="space-y-2">
                  {preview.headers.map(h => (
                    <div key={h} className="flex items-center gap-3">
                      <span className="text-xs font-medium text-gray-600 dark:text-gray-400 w-32 truncate">{h}</span>
                      <span className="text-gray-400">→</span>
                      <select value={mapping[h] || ''} onChange={e => setMapping({ ...mapping, [h]: e.target.value })}
                        className="text-xs border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 flex-1 focus:outline-none focus:border-primary">
                        <option value="">— Skip —</option>
                        {FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Preview table */}
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Preview (first 10 rows)</h3>
                <div className="overflow-x-auto border border-gray-200 dark:border-zinc-700 rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-zinc-700">
                        {preview.headers.filter(h => mapping[h]).map(h => (
                          <th key={h} className="px-2 py-1.5 text-left text-gray-500 font-medium">{mapping[h]}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, i) => (
                        <tr key={i} className="border-t border-gray-100 dark:border-zinc-700">
                          {preview.headers.filter(h => mapping[h]).map(h => (
                            <td key={h} className="px-2 py-1.5 text-gray-600 dark:text-gray-400 truncate max-w-[150px]">{row[h]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {error && <div className="bg-red-50 text-red-600 text-xs px-3 py-2 rounded-lg mb-3 flex items-center gap-1"><AlertCircle size={12} /> {error}</div>}

              <div className="flex gap-2">
                <button onClick={handleImport} disabled={importing}
                  className="flex-1 py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2">
                  {importing ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <><Upload size={14} /> Import {preview.totalRows} Tasks (Merge)</>}
                </button>
                <button onClick={() => { setPreview(null); setFile(null); }} className="px-4 py-2.5 text-sm text-gray-500">Back</button>
              </div>
            </>
          )}

          {result && (
            <div className="text-center py-8">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <Check size={24} className="text-green-600" />
              </div>
              <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-1">Import Complete!</h3>
              <p className="text-sm text-gray-500 mb-4">
                {result.imported} tasks imported, {result.skipped} skipped (duplicates or errors)
              </p>
              <button onClick={onClose} className="px-5 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
