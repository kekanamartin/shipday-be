const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyGoogleAccessToken } = require('../utils/googleAuth');

const CLIENT_ID = 'shipday-client.apps.googleusercontent.com';
const TOKEN = 'ya29.test-access-token-1234567890';

// Fake Google: tokeninfo + userinfo answers chosen per test
const mockGoogle = ({ tokeninfo = {}, tokeninfoOk = true, userinfo = {}, userinfoOk = true } = {}) => {
  global.fetch = async (url) => ({
    ok: String(url).includes('tokeninfo') ? tokeninfoOk : userinfoOk,
    json: async () => (String(url).includes('tokeninfo')
      ? { aud: CLIENT_ID, expires_in: '3500', ...tokeninfo }
      : { email: 'Thabo@Example.com', email_verified: true, name: 'Thabo Nkosi', picture: 'https://x/p.png', ...userinfo }),
  });
};

test.beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
});

test('accepts a token issued to our client and returns Google\'s details', async () => {
  mockGoogle();
  const profile = await verifyGoogleAccessToken(TOKEN);
  assert.deepEqual(profile, { email: 'thabo@example.com', fullName: 'Thabo Nkosi', image: 'https://x/p.png' });
});

test('rejects a missing or junk token without calling Google', async () => {
  global.fetch = async () => { throw new Error('should not be called'); };
  await assert.rejects(verifyGoogleAccessToken(undefined), { status: 401 });
  await assert.rejects(verifyGoogleAccessToken('abc'), { status: 401 });
});

test('rejects a token issued to a different app', async () => {
  mockGoogle({ tokeninfo: { aud: 'someone-else.apps.googleusercontent.com' } });
  await assert.rejects(verifyGoogleAccessToken(TOKEN), /not issued for ShipDay/);
});

test('rejects an expired or revoked token', async () => {
  mockGoogle({ tokeninfoOk: false });
  await assert.rejects(verifyGoogleAccessToken(TOKEN), /expired/);
  mockGoogle({ tokeninfo: { expires_in: '0' } });
  await assert.rejects(verifyGoogleAccessToken(TOKEN), /expired/);
});

test('rejects an unverified Google email', async () => {
  mockGoogle({ userinfo: { email_verified: false } });
  await assert.rejects(verifyGoogleAccessToken(TOKEN), /verify your email/);
});

test('refuses to run when the server has no client ID configured', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  mockGoogle();
  await assert.rejects(verifyGoogleAccessToken(TOKEN), { status: 500 });
});

test('accepts any of several configured client IDs', async () => {
  process.env.GOOGLE_CLIENT_ID = `old-client.apps.googleusercontent.com, ${CLIENT_ID}`;
  mockGoogle();
  assert.equal((await verifyGoogleAccessToken(TOKEN)).email, 'thabo@example.com');
});

test('the sign-in endpoint ignores an email sent in the request body', async () => {
  const { googleLogin } = require('../controller/auth');
  let status;
  let body;
  const res = { status(code) { status = code; return this; }, json(b) { body = b; return this; } };
  global.fetch = async () => { throw new Error('should not be called'); };
  // An attacker sends only an email address, as the old endpoint allowed
  await googleLogin({ body: { email: 'superadmin@shipday.co.za', fullName: 'Attacker' } }, res);
  assert.equal(status, 401);
  assert.match(body.message, /Google sign-in failed/);
});
