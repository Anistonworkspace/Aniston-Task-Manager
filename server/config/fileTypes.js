/**
 * Centralized file type policy configuration.
 *
 * Every upload flow references this single source of truth for allowed
 * extensions, MIME types, size limits, and per-category restrictions.
 *
 * To add a new format: add it to MASTER_FILE_TYPES and then include its
 * extension in the relevant UPLOAD_CATEGORIES entries.
 */

// ── Master extension → MIME map ─────────────────────────────────────
// All formats the platform can ever accept.  Each entry carries the
// canonical MIME type(s) and an optional set of magic-byte signatures
// used for content-based validation.

const MASTER_FILE_TYPES = {
  // ── Images ──
  jpg:  { mimes: ['image/jpeg'], magicBytes: [[0xFF, 0xD8, 0xFF]] },
  jpeg: { mimes: ['image/jpeg'], magicBytes: [[0xFF, 0xD8, 0xFF]] },
  png:  { mimes: ['image/png'],  magicBytes: [[0x89, 0x50, 0x4E, 0x47]] },
  gif:  { mimes: ['image/gif'],  magicBytes: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { mimes: ['image/webp'], magicBytes: [[0x52, 0x49, 0x46, 0x46]] },
  svg:  { mimes: ['image/svg+xml'] },
  bmp:  { mimes: ['image/bmp'],  magicBytes: [[0x42, 0x4D]] },
  ico:  { mimes: ['image/x-icon', 'image/vnd.microsoft.icon'] },
  tiff: { mimes: ['image/tiff'], magicBytes: [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]] },
  tif:  { mimes: ['image/tiff'], magicBytes: [[0x49, 0x49, 0x2A, 0x00], [0x4D, 0x4D, 0x00, 0x2A]] },

  // ── Documents ──
  pdf:  { mimes: ['application/pdf'], magicBytes: [[0x25, 0x50, 0x44, 0x46]] },
  doc:  { mimes: ['application/msword'], magicBytes: [[0xD0, 0xCF, 0x11, 0xE0]] },
  docx: { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  xls:  { mimes: ['application/vnd.ms-excel'], magicBytes: [[0xD0, 0xCF, 0x11, 0xE0]] },
  xlsx: { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  xlsm: { mimes: ['application/vnd.ms-excel.sheet.macroEnabled.12'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  ppt:  { mimes: ['application/vnd.ms-powerpoint'], magicBytes: [[0xD0, 0xCF, 0x11, 0xE0]] },
  pptx: { mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  odt:  { mimes: ['application/vnd.oasis.opendocument.text'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  ods:  { mimes: ['application/vnd.oasis.opendocument.spreadsheet'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  odp:  { mimes: ['application/vnd.oasis.opendocument.presentation'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },

  // ── Text / Data ──
  txt:      { mimes: ['text/plain'] },
  csv:      { mimes: ['text/csv', 'text/plain', 'application/csv'] },
  md:       { mimes: ['text/markdown', 'text/plain'] },
  json:     { mimes: ['application/json', 'text/plain'] },
  xml:      { mimes: ['application/xml', 'text/xml'] },
  yaml:     { mimes: ['application/x-yaml', 'text/yaml', 'text/plain'] },
  yml:      { mimes: ['application/x-yaml', 'text/yaml', 'text/plain'] },

  // ── Code ──
  html: { mimes: ['text/html'] },
  css:  { mimes: ['text/css'] },
  js:   { mimes: ['application/javascript', 'text/javascript', 'text/plain'] },
  py:   { mimes: ['text/x-python', 'text/plain', 'application/x-python-code'] },
  java: { mimes: ['text/x-java-source', 'text/plain'] },
  sql:  { mimes: ['application/sql', 'text/plain', 'text/x-sql'] },

  // ── Archives ──
  zip: { mimes: ['application/zip', 'application/x-zip-compressed'], magicBytes: [[0x50, 0x4B, 0x03, 0x04]] },
  rar: { mimes: ['application/x-rar-compressed', 'application/vnd.rar'], magicBytes: [[0x52, 0x61, 0x72, 0x21]] },
  gz:  { mimes: ['application/gzip'], magicBytes: [[0x1F, 0x8B]] },
  tar: { mimes: ['application/x-tar'] },
  '7z': { mimes: ['application/x-7z-compressed'], magicBytes: [[0x37, 0x7A, 0xBC, 0xAF]] },

  // ── Video ──
  mp4:  { mimes: ['video/mp4'] },
  mov:  { mimes: ['video/quicktime'] },
  avi:  { mimes: ['video/x-msvideo'] },
  mkv:  { mimes: ['video/x-matroska'] },
  webm: { mimes: ['video/webm'] },
  wmv:  { mimes: ['video/x-ms-wmv'] },

  // ── Audio ──
  mp3:  { mimes: ['audio/mpeg'], magicBytes: [[0x49, 0x44, 0x33], [0xFF, 0xFB], [0xFF, 0xF3]] },
  wav:  { mimes: ['audio/wav', 'audio/x-wav'], magicBytes: [[0x52, 0x49, 0x46, 0x46]] },
  ogg:  { mimes: ['audio/ogg'], magicBytes: [[0x4F, 0x67, 0x67, 0x53]] },
  aac:  { mimes: ['audio/aac'] },
  flac: { mimes: ['audio/flac'], magicBytes: [[0x66, 0x4C, 0x61, 0x43]] },

  // ── Design ──
  psd:    { mimes: ['image/vnd.adobe.photoshop', 'application/x-photoshop'], magicBytes: [[0x38, 0x42, 0x50, 0x53]] },
  ai:     { mimes: ['application/postscript', 'application/illustrator'] },
  indd:   { mimes: ['application/x-indesign'] },
  fig:    { mimes: ['application/octet-stream'] },  // Figma exports
  xd:     { mimes: ['application/octet-stream'] },  // Adobe XD
  sketch: { mimes: ['application/zip', 'application/octet-stream'] },

  // ── CAD / Engineering ──
  dwg:  { mimes: ['application/acad', 'application/x-acad', 'application/octet-stream'] },
  dxf:  { mimes: ['application/dxf', 'application/octet-stream'] },
  dgn:  { mimes: ['application/octet-stream'] },
  skp:  { mimes: ['application/octet-stream'] },
  dwf:  { mimes: ['model/vnd.dwf', 'application/octet-stream'] },

  // ── 3D / Manufacturing ──
  step: { mimes: ['application/step', 'application/octet-stream'] },
  stp:  { mimes: ['application/step', 'application/octet-stream'] },
  iges: { mimes: ['application/iges', 'application/octet-stream'] },
  igs:  { mimes: ['application/iges', 'application/octet-stream'] },
  stl:  { mimes: ['model/stl', 'application/sla', 'application/octet-stream'] },
  obj:  { mimes: ['model/obj', 'application/octet-stream'] },

  // ── BIM / Architecture ──
  rvt: { mimes: ['application/octet-stream'] },
  ifc: { mimes: ['application/x-step', 'application/octet-stream'] },

  // ── Database ──
  db:     { mimes: ['application/octet-stream'] },
  sqlite: { mimes: ['application/x-sqlite3', 'application/octet-stream'] },
};

// ── Upload categories ───────────────────────────────────────────────
// Each category defines the extensions allowed for a specific upload
// purpose, plus an optional per-category size limit override.

const UPLOAD_CATEGORIES = {
  // Default for task attachments — broad but controlled
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

  // Avatar images — strict
  avatar: {
    label: 'Profile Avatar',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    maxSizeMB: 5,
  },

  // Director/assistant-manager plan attachments
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

  // Administration / HR documents
  hr_document: {
    label: 'HR Document',
    extensions: ['doc', 'docx', 'xlsx', 'pdf', 'csv'],
    maxSizeMB: 25,
  },

  // Finance & Accounting
  finance: {
    label: 'Finance Document',
    extensions: ['xls', 'xlsx', 'xlsm', 'pdf', 'csv'],
    maxSizeMB: 25,
  },

  // Business Analytics / Data
  analytics: {
    label: 'Analytics File',
    extensions: ['xlsx', 'sql', 'json', 'csv', 'pdf'],
    maxSizeMB: 25,
  },

  // Management / Strategy
  strategy: {
    label: 'Strategy Document',
    extensions: ['ppt', 'pptx', 'pdf', 'doc', 'docx'],
    maxSizeMB: 25,
  },

  // Marketing
  marketing: {
    label: 'Marketing Asset',
    extensions: ['psd', 'ai', 'indd', 'jpg', 'jpeg', 'png', 'pdf', 'svg', 'webp', 'mp4'],
    maxSizeMB: 50,
  },

  // Graphic Design
  design: {
    label: 'Design File',
    extensions: ['psd', 'ai', 'fig', 'xd', 'sketch', 'png', 'jpg', 'jpeg', 'svg', 'pdf', 'webp'],
    maxSizeMB: 50,
  },

  // Web / UI-UX
  uiux: {
    label: 'UI/UX File',
    extensions: ['fig', 'xd', 'sketch', 'svg', 'png', 'webp', 'pdf'],
    maxSizeMB: 50,
  },

  // IT / Software Dev
  code: {
    label: 'Code File',
    extensions: ['html', 'css', 'js', 'py', 'java', 'xml', 'json', 'sql', 'txt', 'md', 'yaml', 'yml'],
    maxSizeMB: 10,
  },

  // Engineering / CAD
  engineering: {
    label: 'Engineering File',
    extensions: ['dwg', 'dxf', 'dgn', 'skp', 'pdf', 'dwf', 'step', 'stp', 'iges', 'igs', 'stl', 'obj'],
    maxSizeMB: 100,
  },

  // Architecture / BIM
  architecture: {
    label: 'Architecture File',
    extensions: ['rvt', 'ifc', 'pdf', 'dwg', 'dxf'],
    maxSizeMB: 100,
  },

  // Legal
  legal: {
    label: 'Legal Document',
    extensions: ['docx', 'pdf'],
    maxSizeMB: 25,
  },

  // Training / L&D
  training: {
    label: 'Training Material',
    extensions: ['pptx', 'docx', 'pdf', 'mp4', 'mp3'],
    maxSizeMB: 100,
  },

  // Media / Communication
  media: {
    label: 'Media File',
    extensions: ['wav', 'mov', 'mp3', 'mp4', 'webm', 'ogg', 'aac', 'flac'],
    maxSizeMB: 100,
  },

  // General purpose (upload-general endpoint)
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

// ── Dangerous extensions that should NEVER be allowed ───────────────
const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'vbe',
  'wsf', 'wsh', 'ps1', 'ps2', 'psc1', 'psc2', 'reg', 'inf', 'lnk',
  'dll', 'sys', 'drv', 'cpl', 'ocx', 'jar', 'jnlp', 'hta', 'msp',
  'mst', 'appx', 'appxbundle',
];

// ── Helper functions ────────────────────────────────────────────────

/**
 * Get the file type config for an extension from the master list.
 */
function getFileTypeConfig(ext) {
  const normalized = (ext || '').toLowerCase().replace(/^\./, '');
  return MASTER_FILE_TYPES[normalized] || null;
}

/**
 * Get the allowed extensions for a given upload category.
 * Falls back to 'general' if category not found.
 */
function getCategoryConfig(category) {
  return UPLOAD_CATEGORIES[category] || UPLOAD_CATEGORIES.general;
}

/**
 * Build the set of allowed MIME types for a given category.
 */
function getAllowedMimesForCategory(category) {
  const config = getCategoryConfig(category);
  const mimes = new Set();
  for (const ext of config.extensions) {
    const ft = MASTER_FILE_TYPES[ext];
    if (ft) {
      ft.mimes.forEach(m => mimes.add(m));
    }
  }
  // Always allow application/octet-stream as fallback for binary formats
  // (design, CAD, etc.) — extension validation catches bad files
  mimes.add('application/octet-stream');
  return Array.from(mimes);
}

/**
 * Get max file size in bytes for a category.
 */
function getMaxSizeForCategory(category) {
  const config = getCategoryConfig(category);
  return (config.maxSizeMB || 25) * 1024 * 1024;
}

/**
 * Build an HTML accept string for a file input.
 * Returns something like ".jpg,.jpeg,.png,.pdf"
 */
function getAcceptStringForCategory(category) {
  const config = getCategoryConfig(category);
  return config.extensions.map(e => `.${e}`).join(',');
}

/**
 * Validate that an extension is allowed for a category.
 */
function isExtensionAllowed(ext, category) {
  const normalized = (ext || '').toLowerCase().replace(/^\./, '');
  if (BLOCKED_EXTENSIONS.includes(normalized)) return false;
  const config = getCategoryConfig(category);
  return config.extensions.includes(normalized);
}

/**
 * Validate that a MIME type is allowed for a category.
 */
function isMimeAllowed(mime, category) {
  const allowed = getAllowedMimesForCategory(category);
  return allowed.includes(mime);
}

/**
 * Get magic byte signatures for a given extension.
 * Returns array of Buffer arrays, or null if none defined.
 */
function getMagicBytesForExtension(ext) {
  const normalized = (ext || '').toLowerCase().replace(/^\./, '');
  const config = MASTER_FILE_TYPES[normalized];
  if (!config || !config.magicBytes) return null;
  return config.magicBytes.map(bytes => Buffer.from(bytes));
}

/**
 * Returns a human-readable list of allowed extensions for error messages.
 */
function getAllowedExtensionsLabel(category) {
  const config = getCategoryConfig(category);
  return config.extensions.map(e => `.${e.toUpperCase()}`).join(', ');
}

module.exports = {
  MASTER_FILE_TYPES,
  UPLOAD_CATEGORIES,
  BLOCKED_EXTENSIONS,
  getFileTypeConfig,
  getCategoryConfig,
  getAllowedMimesForCategory,
  getMaxSizeForCategory,
  getAcceptStringForCategory,
  isExtensionAllowed,
  isMimeAllowed,
  getMagicBytesForExtension,
  getAllowedExtensionsLabel,
};
