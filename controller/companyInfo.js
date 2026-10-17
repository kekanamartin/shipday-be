const CompanyInfo = require('../models/CompanyInfo');

// Get company info
exports.getCompanyInfo = async (req, res) => {
  try {
    const info = await CompanyInfo.findOne();
    res.json(info || {});
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Save or update company info (JSON body; logo is an image data URL, '' to remove, or omitted to keep)
exports.saveCompanyInfo = async (req, res) => {
  try {
    const { companyName, email, phone, address, logo, preferences = {} } = req.body || {};
    const clean = (value) => String(value || '').trim();

    if (!clean(companyName) || !clean(email) || !clean(phone) || !clean(address)) {
      return res.status(400).json({ message: 'Company name, email, phone and address are required' });
    }
    if (logo !== undefined && logo !== null && logo !== '' && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/.test(logo)) {
      return res.status(400).json({ message: 'Logo must be a PNG, JPG, WebP or SVG image' });
    }

    const update = {
      companyName: clean(companyName),
      email: clean(email),
      phone: clean(phone),
      address: clean(address),
      preferences: {
        currency: clean(preferences.currency) || 'ZAR',
        timezone: clean(preferences.timezone) || 'Africa/Johannesburg',
        language: clean(preferences.language) || 'English',
      },
    };
    if (logo !== undefined) update.logo = logo || null;

    let info = await CompanyInfo.findOne();
    if (info) {
      info.set(update);
    } else {
      info = new CompanyInfo(update);
    }
    await info.save();
    res.json(info);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
