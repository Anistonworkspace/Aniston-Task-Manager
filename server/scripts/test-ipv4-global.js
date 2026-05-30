// Mirrors the server.js boot sequence EXACTLY, then makes a plain axios
// request. If this succeeds, the global dns.lookup patch works.

require('dotenv').config({ path: '/app/.env' });

if (process.env.NODE_ENV !== 'production' || process.env.FORCE_IPV4_DNS === 'true') {
  try {
    const dns = require('dns');
    const originalLookup = dns.lookup;
    dns.lookup = function patchedLookup(hostname, optionsOrCb, callback) {
      let options = optionsOrCb;
      let cb = callback;
      if (typeof options === 'function') { cb = options; options = {}; }
      else if (typeof options === 'number') { options = { family: options }; }
      else if (options == null) { options = {}; }
      if (options.family === undefined || options.family === 0) {
        options = Object.assign({}, options, { family: 4 });
      }
      return originalLookup.call(dns, hostname, options, cb);
    };
    try { require('net').setDefaultAutoSelectFamily(false); } catch (_) {}
  } catch (_) {}
}

const dns = require('dns');
console.log('Testing patched dns.lookup defaults:');
dns.lookup('login.microsoftonline.com', (e, addr, fam) => {
  console.log('  login.microsoftonline.com ->', addr, 'family:', fam);
});
dns.lookup('graph.microsoft.com', (e, addr, fam) => {
  console.log('  graph.microsoft.com ->', addr, 'family:', fam);
});

const axios = require('axios');
(async () => {
  await new Promise(r => setTimeout(r, 500)); // let async dns logs print
  console.log('\nPlain axios.get → login.microsoftonline.com:');
  try {
    const res = await axios.get('https://login.microsoftonline.com/common/.well-known/openid-configuration', { timeout: 8000 });
    console.log('  OK status', res.status);
  } catch (err) {
    console.error('  FAILED:', err.code, err.message);
  }

  console.log('\nPlain axios.get → graph.microsoft.com (expects 401, but TCP should succeed):');
  try {
    const res = await axios.get('https://graph.microsoft.com/v1.0/users', { timeout: 8000 });
    console.log('  Unexpected OK status', res.status);
  } catch (err) {
    if (err.response) {
      console.log('  OK — got HTTP', err.response.status, '(reached server)');
    } else {
      console.error('  FAILED:', err.code, err.message);
    }
  }
})();
