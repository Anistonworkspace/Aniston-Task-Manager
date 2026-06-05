/**
 * Unit / integration tests for fileBackupService.
 *
 * The FileBackupRecord model is replaced with a tiny in-memory store, but the
 * filesystem + tar operations run FOR REAL against temp directories — that's
 * the whole point: we want to prove the .tar.gz is actually produced, passes
 * the integrity check, and round-trips back out on restore.
 *
 * BACKUP_ROOT is derived at module-load from DB_BACKUP_DIR, so that env var is
 * set to a temp dir BEFORE the service (and backupService, which it reuses for
 * the root) is required.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { Op } = require('sequelize');
const tar = require('tar');

// ── Temp dirs (created synchronously so they exist before module load) ─────
// `mock`-prefixed names so jest's hoisted mock factories may reference them.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fbsvc-'));
const BACKUP_DIR = path.join(TMP_ROOT, 'backups');
const mockUploadsDir = path.join(TMP_ROOT, 'uploads');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(mockUploadsDir, { recursive: true });
process.env.DB_BACKUP_DIR = BACKUP_DIR;

// ── In-memory FileBackupRecord store ───────────────────────────────────────
let mockRows = [];
let mockIdSeq = 0;

function makeInstance(fields) {
  const inst = {
    ...fields,
    id: fields.id || `rec-${++mockIdSeq}`,
    createdAt: fields.createdAt || new Date(),
    async save() {
      const idx = mockRows.findIndex((r) => r.id === this.id);
      if (idx >= 0) mockRows[idx] = this;
      return this;
    },
    async destroy() {
      mockRows = mockRows.filter((r) => r.id !== this.id);
    },
    get(opts) { return opts && opts.plain ? { ...this } : this; },
  };
  return inst;
}

const mockFileBackupRecord = {
  async create(fields) {
    const inst = makeInstance(fields);
    mockRows.push(inst);
    return inst;
  },
  async findOne({ where = {}, order } = {}) {
    let matches = mockRows.filter((r) => {
      if (where.status && r.status !== where.status) return false;
      if (where.trigger && r.trigger !== where.trigger) return false;
      return true;
    });
    if (order) matches = matches.sort((a, b) => b.createdAt - a.createdAt);
    return matches[0] || null;
  },
  async findByPk(id) {
    return mockRows.find((r) => r.id === id) || null;
  },
  async findAll({ where = {}, limit, offset = 0 } = {}) {
    let matches = mockRows.filter((r) => {
      if (where.status && r.status !== where.status) return false;
      if (where.trigger && r.trigger !== where.trigger) return false;
      // Op.lt on createdAt — treat as match-all (we control timestamps in tests).
      return true;
    });
    matches = matches.sort((a, b) => b.createdAt - a.createdAt);
    if (typeof limit === 'number') matches = matches.slice(offset, offset + limit);
    return matches;
  },
  async update(fields, { where = {} } = {}) {
    const target = mockRows.find((r) => r.id === where.id);
    if (target) Object.assign(target, fields);
    return [target ? 1 : 0];
  },
};

jest.mock('../../models', () => ({ FileBackupRecord: mockFileBackupRecord }));
jest.mock('../../middleware/upload', () => ({ getUploadDir: () => mockUploadsDir }));
jest.mock('../../utils/safeLogger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const fileBackupService = require('../../services/fileBackupService');
const FileBackupRecord = mockFileBackupRecord;
const UPLOADS_DIR = mockUploadsDir;

// ── Helpers ────────────────────────────────────────────────────────────────
async function seedUploads() {
  await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
  await fsp.mkdir(path.join(UPLOADS_DIR, 'avatars'), { recursive: true });
  await fsp.writeFile(path.join(UPLOADS_DIR, 'doc.pdf'), 'pdf-bytes-here');
  await fsp.writeFile(path.join(UPLOADS_DIR, 'avatars', 'me.png'), Buffer.alloc(512, 9));
}

async function countArchiveEntries(absPath) {
  let n = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(absPath);
    const p = new tar.Parser({ gzip: true });
    s.on('error', reject); p.on('error', reject); p.on('end', resolve);
    p.on('entry', (e) => { n++; e.resume(); });
    s.pipe(p);
  });
  return n;
}

beforeEach(async () => {
  mockRows = [];
  mockIdSeq = 0;
  await seedUploads();
  await fileBackupService.ensureDirectories();
});

afterAll(async () => {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('fileBackupService.createFilesBackup', () => {
  it('produces a completed record with a real, valid .tar.gz on disk', async () => {
    const rec = await fileBackupService.createFilesBackup({ trigger: 'manual', createdBy: 'u1' });

    expect(rec.status).toBe('completed');
    expect(rec.progressPercent).toBe(100);
    expect(rec.filename).toMatch(fileBackupService.FILENAME_RE);
    expect(Number(rec.sizeBytes)).toBeGreaterThan(0);

    // File exists on disk and contains the uploaded files.
    const onDisk = await fsp.stat(rec.path);
    expect(onDisk.isFile()).toBe(true);
    const entries = await countArchiveEntries(rec.path);
    expect(entries).toBeGreaterThanOrEqual(3); // '.', doc.pdf, avatars/, me.png
  });

  it('archives an empty uploads dir without throwing', async () => {
    await fsp.rm(UPLOADS_DIR, { recursive: true, force: true });
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });
    const rec = await fileBackupService.createFilesBackup({ trigger: 'manual', createdBy: 'u1' });
    expect(rec.status).toBe('completed');
    expect(Number(rec.sizeBytes)).toBeGreaterThan(0);
  });

  it('rejects a second concurrent backup while one is running', async () => {
    // Simulate an in-flight row.
    await FileBackupRecord.create({ filename: 'x', path: path.join(BACKUP_DIR, 'files', 'x'), trigger: 'manual', status: 'running' });
    await expect(
      fileBackupService.createFilesBackup({ trigger: 'manual', createdBy: 'u1' })
    ).rejects.toMatchObject({ code: 'BACKUP_ALREADY_RUNNING' });
  });

  it('rejects an invalid trigger', async () => {
    await expect(
      fileBackupService.createFilesBackup({ trigger: 'bogus' })
    ).rejects.toThrow(/Invalid trigger/);
  });
});

describe('fileBackupService.restoreFilesFromRecord', () => {
  it('restores a deleted upload from the archive and takes a pre-restore snapshot', async () => {
    const rec = await fileBackupService.createFilesBackup({ trigger: 'manual', createdBy: 'u1' });

    // Delete a file from the live uploads dir, then restore.
    await fsp.rm(path.join(UPLOADS_DIR, 'doc.pdf'));
    expect(fs.existsSync(path.join(UPLOADS_DIR, 'doc.pdf'))).toBe(false);

    const result = await fileBackupService.restoreFilesFromRecord({
      recordId: rec.id,
      actingUser: { id: 'u1' },
    });

    // File is back.
    expect(fs.existsSync(path.join(UPLOADS_DIR, 'doc.pdf'))).toBe(true);
    expect(await fsp.readFile(path.join(UPLOADS_DIR, 'doc.pdf'), 'utf8')).toBe('pdf-bytes-here');

    // A pre_restore safety archive was created.
    expect(result.preRestoreId).toBeTruthy();
    const pre = await FileBackupRecord.findByPk(result.preRestoreId);
    expect(pre.trigger).toBe('pre_restore');
    expect(pre.status).toBe('completed');
  });

  it('refuses to restore from a non-completed record', async () => {
    const rec = await FileBackupRecord.create({
      filename: 'files_manual_x', path: path.join(BACKUP_DIR, 'files', 'nope.tar.gz'),
      trigger: 'manual', status: 'failed',
    });
    await expect(
      fileBackupService.restoreFilesFromRecord({ recordId: rec.id, actingUser: { id: 'u1' } })
    ).rejects.toMatchObject({ code: 'BACKUP_NOT_READY' });
  });
});

describe('fileBackupService.deleteFileBackup', () => {
  it('removes both the row and the file on disk', async () => {
    const rec = await fileBackupService.createFilesBackup({ trigger: 'manual', createdBy: 'u1' });
    expect(fs.existsSync(rec.path)).toBe(true);

    await fileBackupService.deleteFileBackup({ recordId: rec.id, actingUser: { id: 'u1' } });

    expect(fs.existsSync(rec.path)).toBe(false);
    expect(await FileBackupRecord.findByPk(rec.id)).toBeNull();
  });

  it('blocks deletion of a row whose path escapes the backup root', async () => {
    const rec = await FileBackupRecord.create({
      filename: 'evil', path: path.join(os.tmpdir(), 'evil.tar.gz'), trigger: 'manual', status: 'completed',
    });
    await expect(
      fileBackupService.deleteFileBackup({ recordId: rec.id, actingUser: { id: 'u1' } })
    ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
  });
});

describe('fileBackupService retention + listing', () => {
  it('lists newest-first', async () => {
    const a = await fileBackupService.createFilesBackup({ trigger: 'manual' });
    a.createdAt = new Date(Date.now() - 10000);
    const b = await fileBackupService.createFilesBackup({ trigger: 'manual' });
    const list = await fileBackupService.listBackups({ limit: 10 });
    expect(list[0].id).toBe(b.id);
  });
});
