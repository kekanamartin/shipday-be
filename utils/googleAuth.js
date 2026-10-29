// Verifies a Google sign-in on the server instead of trusting what the browser sends.
//
// The browser signs in with Google Identity Services and sends us the short-lived access token.
// We ask Google (not the browser) who the token belongs to, and only accept it when:
//   - it was issued to OUR OAuth client (GOOGLE_CLIENT_ID), so a token from another app can't be replayed
//   - it hasn't expired
//   - Google has verified the email address
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

class GoogleAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

// GOOGLE_CLIENT_ID can list several IDs, comma-separated (e.g. while moving to a new client)
const allowedClientIds = () =>
  String(process.env.GOOGLE_CLIENT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

async function verifyGoogleAccessToken(accessToken) {
  const clientIds = allowedClientIds();
  if (!clientIds.length) {
    throw new GoogleAuthError('Google sign-in is not set up on the server (GOOGLE_CLIENT_ID is missing).', 500);
  }
  if (typeof accessToken !== 'string' || accessToken.length < 20) {
    throw new GoogleAuthError('Google sign-in failed. Please try again.');
  }

  const info = await getJson(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  if (!info.ok) throw new GoogleAuthError('Your Google session has expired. Please try again.');

  const audience = info.body.aud || info.body.azp;
  if (!clientIds.includes(audience)) {
    throw new GoogleAuthError('This Google sign-in was not issued for ShipDay.');
  }
  if (!(Number(info.body.expires_in) > 0)) {
    throw new GoogleAuthError('Your Google session has expired. Please try again.');
  }

  const profile = await getJson(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!profile.ok || !profile.body.email) {
    throw new GoogleAuthError('We could not read your Google account details. Please try again.');
  }
  if (profile.body.email_verified !== true && profile.body.email_verified !== 'true') {
    throw new GoogleAuthError('Please verify your email address with Google first.');
  }

  return {
    email: String(profile.body.email).toLowerCase(),
    fullName: profile.body.name || [profile.body.given_name, profile.body.family_name].filter(Boolean).join(' '),
    image: profile.body.picture || '',
  };
}

module.exports = { verifyGoogleAccessToken, GoogleAuthError };
