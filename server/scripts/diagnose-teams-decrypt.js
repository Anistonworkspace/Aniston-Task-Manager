// Diagnose whether the restored Microsoft Teams clientSecret can be decrypted
// with the current ENCRYPTION_KEY. If decryption fails, the key changed since
// the backup was made. Tests the actual round-trip: read ciphertext → decrypt
// → call Microsoft Azure to acquire a token.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const IntegrationConfig = require('../models/IntegrationConfig');
const { decrypt } = require('../utils/encryption');
const axios = require('axios');
const https = require('https');
const ipv4Agent = new https.Agent({ family: 4 });

(async () => {
  try {
    console.log('ENCRYPTION_KEY present?', !!process.env.ENCRYPTION_KEY);
    console.log('ENCRYPTION_KEY length:', process.env.ENCRYPTION_KEY?.length);

    const cfg = await IntegrationConfig.findOne({ where: { provider: 'microsoft' } });
    if (!cfg) {
      console.log('No microsoft integration config row in DB.');
      process.exit(0);
    }
    console.log('Found microsoft IntegrationConfig row id=', cfg.id);
    console.log('clientId  ciphertext length:', cfg.clientId?.length);
    console.log('clientSec ciphertext length:', cfg.clientSecret?.length);
    console.log('tenantId  (plain):', cfg.tenantId);

    let clientId, clientSecret;
    try { clientId = decrypt(cfg.clientId); console.log('decrypt(clientId) OK -> length', clientId.length, 'preview', clientId.slice(0, 8) + '…'); }
    catch (e) { console.error('decrypt(clientId) FAILED:', e.message); }

    try { clientSecret = decrypt(cfg.clientSecret); console.log('decrypt(clientSecret) OK -> length', clientSecret.length, 'preview', '…' + clientSecret.slice(-4)); }
    catch (e) { console.error('decrypt(clientSecret) FAILED:', e.message); }

    if (!clientId || !clientSecret) {
      console.error('Cannot test Azure — decryption failed.');
      process.exit(1);
    }

    console.log('Calling Microsoft token endpoint...');
    try {
      const tokenRes = await axios.post(
        `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000, httpsAgent: ipv4Agent }
      );
      console.log('Microsoft token call OK. access_token present?', !!tokenRes.data.access_token);
    } catch (err) {
      console.error('Microsoft token call FAILED:');
      console.error('  status:', err.response?.status);
      console.error('  error:', err.response?.data?.error);
      console.error('  error_description:', err.response?.data?.error_description);
      console.error('  message:', JSON.stringify(err.message));
      console.error('  code:', err.code);
      console.error('  errno:', err.errno);
      console.error('  syscall:', err.syscall);
      console.error('  cause:', err.cause);
      console.error('  isAxiosError:', err.isAxiosError);
      console.error('  name:', err.name);
      console.error('  stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Diagnostic failed:', err);
    process.exit(1);
  }
})();
