// Links for setting a password: team invitations (3 days) and "forgot password" (15 minutes).
// A link stops working as soon as the password changes, so each one can only be used once.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const sendMail = require('../utils/mail');

const TTL = { invite: '3d', reset: '15m' };

const frontendUrl = () => (process.env.BASE_URL || process.env.FRONTEND_URL || 'https://shipday-fe.vercel.app')
  .split(',')[0].trim().replace(/\/+$/, '');

const passwordFingerprint = (user) => crypto.createHash('sha256').update(String(user.password || '')).digest('hex').slice(0, 16);

const signPasswordToken = (user, purpose) => jwt.sign(
  { id: String(user._id), purpose, v: passwordFingerprint(user) },
  process.env.JWT_SECRET,
  { expiresIn: TTL[purpose] },
);

class PasswordTokenError extends Error {}

// The user the link belongs to, or a PasswordTokenError explaining why it can't be used
const verifyPasswordToken = async (token, purposes = ['invite', 'reset']) => {
  let decoded;
  try {
    decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
  } catch (err) {
    throw new PasswordTokenError(err.name === 'TokenExpiredError'
      ? 'This link has expired. Please ask for a new one.'
      : 'This link is not valid.');
  }
  if (!purposes.includes(decoded.purpose)) throw new PasswordTokenError('This link is not valid.');
  const user = await User.findById(decoded.id);
  if (!user || decoded.v !== passwordFingerprint(user)) {
    throw new PasswordTokenError('This link has already been used. Please ask for a new one.');
  }
  return { user, purpose: decoded.purpose };
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Email a team member the link to set their password and sign in
const sendInvite = async (user, { invitedBy, hubName } = {}) => {
  const link = `${frontendUrl()}/set-password?token=${encodeURIComponent(signPasswordToken(user, 'invite'))}`;
  const where = hubName ? ` at ${hubName}` : '';
  const text = [
    `Hello ${user.fullName || ''},`,
    '',
    `${invitedBy ? `${invitedBy} has` : 'You have been'} added you to ShipDay as ${user.role}${where}.`,
    `Set your password here (the link works for 3 days): ${link}`,
    '',
    `After that, sign in at ${frontendUrl()}/login with ${user.email}.`,
  ].join('\n');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: auto; padding: 24px; border: 1px solid #e6e3da; border-radius: 12px; background: #FFFFFF;">
      <h2 style="color: #000000; margin-top: 0;">Welcome to ShipDay</h2>
      <p style="color: #333333;">Hello ${escapeHtml(user.fullName)},</p>
      <p style="color: #333333;">${invitedBy ? `${escapeHtml(invitedBy)} has` : 'You have been'} added you to ShipDay as <strong>${escapeHtml(user.role)}</strong>${escapeHtml(where)}.</p>
      <p style="text-align: center; margin: 28px 0;">
        <a href="${link}" style="background: #D3A003; color: #000000; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none;">Set my password</a>
      </p>
      <p style="color: #666666; font-size: 13px;">The link works for 3 days. Afterwards, sign in with ${escapeHtml(user.email)}.</p>
    </div>`;
  await sendMail(user.email, 'Your ShipDay login', text, html);
  user.invite = { ...(user.invite || {}), sentAt: new Date() };
  await user.save();
  return link;
};

module.exports = {
  signPasswordToken, verifyPasswordToken, sendInvite, PasswordTokenError, frontendUrl, escapeHtml,
};
