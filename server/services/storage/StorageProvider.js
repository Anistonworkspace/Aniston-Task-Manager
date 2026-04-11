/**
 * Abstract storage provider interface.
 *
 * Every concrete provider (local, S3, Cloudinary, …) must implement
 * these methods.  Business logic never calls fs/S3/etc. directly —
 * it always goes through the active provider.
 */
class StorageProvider {
  /**
   * Store a file.
   * @param {Object} opts
   * @param {string} opts.filePath   - Absolute path to the temp/local file on disk
   * @param {string} opts.filename   - Generated safe filename (e.g. "17756…-496049144.png")
   * @param {string} opts.originalName - User-provided original name
   * @param {string} opts.mimetype   - Validated MIME type
   * @param {number} opts.size       - Size in bytes
   * @param {string} opts.category   - Upload category (e.g. "task_attachment")
   * @returns {Promise<{ url: string, storedPath: string }>}
   *   url        – public or relative URL used to retrieve the file
   *   storedPath – provider-specific internal path / key
   */
  async store(/* opts */) {
    throw new Error('StorageProvider.store() must be implemented');
  }

  /**
   * Delete a previously stored file.
   * @param {string} filename  - The stored filename / key
   * @param {string} category  - Upload category (for path resolution)
   * @returns {Promise<void>}
   */
  async remove(/* filename, category */) {
    throw new Error('StorageProvider.remove() must be implemented');
  }

  /**
   * Check whether a stored file exists.
   * @param {string} filename
   * @param {string} category
   * @returns {Promise<boolean>}
   */
  async exists(/* filename, category */) {
    throw new Error('StorageProvider.exists() must be implemented');
  }

  /**
   * Resolve the absolute local file path (for providers that serve
   * from disk) or a signed/public URL (for remote providers).
   * @param {string} filename
   * @param {string} category
   * @returns {Promise<string>}
   */
  async resolve(/* filename, category */) {
    throw new Error('StorageProvider.resolve() must be implemented');
  }

  /**
   * Build the URL that will be stored in the database / returned to clients.
   * @param {string} filename
   * @param {string} category
   * @returns {string}
   */
  getUrl(/* filename, category */) {
    throw new Error('StorageProvider.getUrl() must be implemented');
  }

  /** Human-readable provider name, e.g. "local", "s3", "cloudinary" */
  get name() {
    throw new Error('StorageProvider.name must be implemented');
  }
}

module.exports = StorageProvider;
