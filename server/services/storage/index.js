/**
 * Storage provider factory.
 *
 * Reads STORAGE_PROVIDER from env and returns the matching provider
 * singleton.  Add new providers here as they are implemented.
 *
 * Usage:
 *   const { getProvider } = require('./services/storage');
 *   const storage = getProvider();
 *   await storage.store({ ... });
 */

const LocalStorageProvider = require('./LocalStorageProvider');
// Future providers:
// const S3StorageProvider = require('./S3StorageProvider');
// const CloudinaryStorageProvider = require('./CloudinaryStorageProvider');

let _instance = null;

function getProvider() {
  if (_instance) return _instance;

  const providerName = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();

  switch (providerName) {
    case 'local':
      _instance = new LocalStorageProvider();
      break;

    // case 's3':
    //   _instance = new S3StorageProvider({
    //     bucket: process.env.S3_BUCKET,
    //     region: process.env.S3_REGION,
    //     accessKeyId: process.env.S3_ACCESS_KEY_ID,
    //     secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    //   });
    //   break;

    // case 'cloudinary':
    //   _instance = new CloudinaryStorageProvider({
    //     cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    //     apiKey: process.env.CLOUDINARY_API_KEY,
    //     apiSecret: process.env.CLOUDINARY_API_SECRET,
    //   });
    //   break;

    default:
      console.warn(`[Storage] Unknown provider "${providerName}", falling back to local.`);
      _instance = new LocalStorageProvider();
  }

  console.log(`[Storage] Using provider: ${_instance.name}`);
  return _instance;
}

/** Reset the cached instance (useful for testing). */
function resetProvider() {
  _instance = null;
}

module.exports = { getProvider, resetProvider, LocalStorageProvider };
