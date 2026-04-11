const fs = require('fs');
const path = require('path');
const StorageProvider = require('./StorageProvider');

/**
 * Local filesystem storage provider.
 *
 * Files are stored flat inside the configured upload directory
 * (defaults to <project>/server/uploads).  This keeps backward
 * compatibility with all existing uploads.
 */
class LocalStorageProvider extends StorageProvider {
  constructor(uploadDir) {
    super();
    this._uploadDir = uploadDir || path.join(__dirname, '..', '..', process.env.UPLOAD_DIR || 'uploads');
    if (!fs.existsSync(this._uploadDir)) {
      fs.mkdirSync(this._uploadDir, { recursive: true });
    }
  }

  get name() {
    return 'local';
  }

  get uploadDir() {
    return this._uploadDir;
  }

  async store({ filePath, filename }) {
    // Multer already wrote the file into uploadDir via disk storage,
    // so for the local provider the file is already in place.
    // If filePath differs from the target (e.g. a temp upload), move it.
    const targetPath = path.join(this._uploadDir, filename);
    if (filePath !== targetPath && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, targetPath);
      fs.unlinkSync(filePath);
    }
    return {
      url: `/uploads/${filename}`,
      storedPath: targetPath,
    };
  }

  async remove(filename) {
    const filePath = path.join(this._uploadDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async exists(filename) {
    return fs.existsSync(path.join(this._uploadDir, filename));
  }

  async resolve(filename) {
    return path.join(this._uploadDir, filename);
  }

  getUrl(filename) {
    return `/uploads/${filename}`;
  }
}

module.exports = LocalStorageProvider;
