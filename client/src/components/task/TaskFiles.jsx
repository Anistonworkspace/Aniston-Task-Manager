import React, { useRef } from 'react';
import { Upload, FileText, Image, Film, FileArchive, Download, Trash2 } from 'lucide-react';

function getIcon(name) {
  if (!name) return FileText;
  const ext = name.split('.').pop()?.toLowerCase();
  if (['jpg','jpeg','png','gif','svg','webp'].includes(ext)) return Image;
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return Film;
  if (['zip','rar','7z','tar','gz'].includes(ext)) return FileArchive;
  return FileText;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B','KB','MB','GB'];
  let i = 0, s = bytes;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export default function TaskFiles({ files, onUpload, onDelete }) {
  const inputRef = useRef(null);

  function handleSelect(e) {
    Array.from(e.target.files || []).forEach(f => onUpload(f));
    e.target.value = '';
  }

  return (
    <div>
      <div onClick={() => inputRef.current?.click()} onDrop={(e) => { e.preventDefault(); Array.from(e.dataTransfer.files).forEach(f => onUpload(f)); }} onDragOver={(e) => e.preventDefault()}
        className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors mb-4">
        <Upload size={24} className="mx-auto mb-2 text-text-tertiary" />
        <p className="text-sm text-text-secondary"><span className="font-semibold text-primary">Click to upload</span> or drag and drop</p>
      </div>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={handleSelect} />

      {files.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-4">No files attached</p>
      ) : (
        <div className="flex flex-col gap-2">
          {files.map(f => {
            const Icon = getIcon(f.originalName || f.filename);
            return (
              <div key={f.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border hover:bg-surface/50 group transition-colors">
                <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center text-primary flex-shrink-0"><Icon size={16} /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{f.originalName || f.filename}</p>
                  <p className="text-xs text-text-tertiary">{formatSize(f.size)}</p>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a href={f.url || `/uploads/${f.filename}`} download className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><Download size={14} /></a>
                  <button onClick={() => onDelete(f.id)} className="p-1.5 rounded-md hover:bg-red-50 text-text-secondary hover:text-danger"><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
