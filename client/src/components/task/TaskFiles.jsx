import React, { useRef, useState } from 'react';
import {
  Upload, FileText, Image, Film, FileArchive, Download, Trash2,
  Music, FileSpreadsheet, Presentation, Code, Pen, Box,
} from 'lucide-react';
import { getAcceptString, validateFile, formatFileSize, getFileTypeGroup, getMaxSizeLabel } from '../../utils/uploadConfig';

const ICON_MAP = {
  image: Image,
  video: Film,
  audio: Music,
  archive: FileArchive,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  code: Code,
  design: Pen,
  cad: Box,
};

function getIcon(name) {
  const group = getFileTypeGroup(name);
  return ICON_MAP[group] || FileText;
}

export default function TaskFiles({ files, onUpload, onDelete, category = 'task_attachment' }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState([]);

  function handleFiles(fileList) {
    const errs = [];
    Array.from(fileList).forEach(f => {
      const result = validateFile(f, category);
      if (result.valid) {
        onUpload(f);
      } else {
        errs.push(`${f.name}: ${result.message}`);
      }
    });
    if (errs.length) {
      setErrors(errs);
      setTimeout(() => setErrors([]), 6000);
    }
  }

  function handleSelect(e) {
    handleFiles(e.target.files || []);
    e.target.value = '';
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div>
      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors mb-4 ${
          dragOver
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary/40 hover:bg-primary/5'
        }`}
      >
        <Upload size={24} className="mx-auto mb-2 text-text-tertiary" />
        <p className="text-sm text-text-secondary">
          <span className="font-semibold text-primary">Click to upload</span> or drag and drop
        </p>
        <p className="text-xs text-text-tertiary mt-1">Max {getMaxSizeLabel(category)}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={getAcceptString(category)}
        className="hidden"
        onChange={handleSelect}
      />

      {/* Validation errors */}
      {errors.length > 0 && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          {errors.map((err, i) => (
            <p key={i} className="text-xs text-red-600">{err}</p>
          ))}
        </div>
      )}

      {/* File list */}
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
                  <p className="text-xs text-text-tertiary">{formatFileSize(f.size)}</p>
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
