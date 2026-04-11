/**
 * Centralized frontend upload configuration.
 *
 * Mirrors the backend's fileTypes.js — keeps accept strings, size
 * limits, and validation logic in one place so every upload component
 * stays consistent.
 */

// ── Category configs ────────────────────────────────────────────────

const UPLOAD_CATEGORIES = {
  task_attachment: {
    label: 'Task Attachment',
    extensions: [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'odt', 'ods', 'odp',
      'txt', 'csv', 'md', 'json', 'xml', 'yaml', 'yml',
      'html', 'css', 'js', 'py', 'java', 'sql',
      'zip', 'rar', 'gz', 'tar', '7z',
      'mp4', 'mov', 'avi', 'mkv', 'webm',
      'mp3', 'wav', 'ogg',
      'psd', 'ai', 'fig', 'xd', 'sketch',
      'dwg', 'dxf', 'skp', 'step', 'stp', 'stl', 'obj',
    ],
    maxSizeMB: 25,
  },
  avatar: {
    label: 'Profile Avatar',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    maxSizeMB: 5,
  },
  plan_attachment: {
    label: 'Plan Attachment',
    extensions: [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'txt', 'csv', 'md', 'json',
      'zip',
    ],
    maxSizeMB: 25,
  },
  general: {
    label: 'General Upload',
    extensions: [
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'txt', 'csv', 'md', 'json', 'xml',
      'zip', 'rar', 'gz',
      'mp4', 'mp3',
    ],
    maxSizeMB: 25,
  },
};

// ── Blocked extensions (never allow) ────────────────────────────────

const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'vbe',
  'wsf', 'wsh', 'ps1', 'reg', 'lnk', 'dll', 'sys', 'jar', 'hta',
];

// ── Helper functions ────────────────────────────────────────────────

/**
 * Get the config for a given upload category.
 */
export function getCategoryConfig(category) {
  return UPLOAD_CATEGORIES[category] || UPLOAD_CATEGORIES.general;
}

/**
 * Build the `accept` attribute string for a file input.
 */
export function getAcceptString(category) {
  const config = getCategoryConfig(category);
  return config.extensions.map(e => `.${e}`).join(',');
}

/**
 * Get max file size in bytes for a category.
 */
export function getMaxSizeBytes(category) {
  const config = getCategoryConfig(category);
  return (config.maxSizeMB || 25) * 1024 * 1024;
}

/**
 * Get max file size label (e.g. "25 MB").
 */
export function getMaxSizeLabel(category) {
  const config = getCategoryConfig(category);
  return `${config.maxSizeMB || 25} MB`;
}

/**
 * Validate a File object against a category's rules.
 * Returns { valid: true } or { valid: false, message: string }.
 */
export function validateFile(file, category) {
  const config = getCategoryConfig(category);
  const ext = (file.name || '').split('.').pop()?.toLowerCase() || '';

  // Block dangerous extensions
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return { valid: false, message: `File type .${ext} is not allowed for security reasons.` };
  }

  // Check extension
  if (!config.extensions.includes(ext)) {
    return {
      valid: false,
      message: `File type .${ext.toUpperCase()} is not allowed. Allowed: ${config.extensions.map(e => `.${e}`).join(', ')}`,
    };
  }

  // Check size
  const maxBytes = (config.maxSizeMB || 25) * 1024 * 1024;
  if (file.size > maxBytes) {
    return {
      valid: false,
      message: `File too large (${formatFileSize(file.size)}). Maximum is ${config.maxSizeMB || 25} MB.`,
    };
  }

  return { valid: true };
}

/**
 * Format bytes into human-readable size.
 */
export function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let s = bytes;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ── File icon / type helpers ────────────────────────────────────────

const FILE_TYPE_GROUPS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'psd', 'ai'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'aac', 'flac'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
  spreadsheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv'],
  presentation: ['ppt', 'pptx', 'odp'],
  document: ['doc', 'docx', 'odt', 'pdf', 'txt', 'md'],
  code: ['html', 'css', 'js', 'py', 'java', 'sql', 'json', 'xml', 'yaml', 'yml'],
  design: ['fig', 'xd', 'sketch', 'indd'],
  cad: ['dwg', 'dxf', 'dgn', 'skp', 'dwf', 'step', 'stp', 'iges', 'igs', 'stl', 'obj', 'rvt', 'ifc'],
};

/**
 * Determine the type group of a file based on its extension.
 */
export function getFileTypeGroup(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  for (const [group, exts] of Object.entries(FILE_TYPE_GROUPS)) {
    if (exts.includes(ext)) return group;
  }
  return 'other';
}

/**
 * Check if a file extension is previewable in the browser.
 */
export function isPreviewable(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  const previewable = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'pdf', 'txt', 'mp4', 'webm', 'mp3', 'ogg', 'wav'];
  return previewable.includes(ext);
}

export { UPLOAD_CATEGORIES, BLOCKED_EXTENSIONS, FILE_TYPE_GROUPS };
