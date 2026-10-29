const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const payfastMode = () => (process.env.PAYFAST_MODE || 'sandbox').trim().toLowerCase();
const payfastHost = () => (payfastMode() === 'sandbox' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za');

// API_URL should be the backend address including /api; add it if it was left off
const apiBaseUrl = () => {
    const url = (process.env.API_URL || 'https://shipday-be-pi.vercel.app/api').trim().replace(/\/+$/, '');
    return url.endsWith('/api') ? url : `${url}/api`;
};

const pfValidSignature = (data, passPhrase = null) => {
    let pfOutput = "";

    // PayFast requires specific order or at least consistent order
    // We iterate through keys and build the string
    for (let key in data) {
        if (data.hasOwnProperty(key) && key !== "signature") {
            let val = data[key];
            if (val !== undefined && val !== null && String(val).trim() !== "") {
                pfOutput += `${key}=${encodeURIComponent(String(val).trim()).replace(/%20/g, "+")}&`;
            }
        }
    }

    // Remove last ampersand
    let getString = pfOutput.slice(0, -1);

    // Append Passphrase if it exists
    if (passPhrase && passPhrase.trim() !== "") {
        getString += `&passphrase=${encodeURIComponent(passPhrase.trim()).replace(/%20/g, "+")}`;
    }

    return crypto.createHash("md5").update(getString).digest("hex");
};

const generatePaymentData = (shipment) => {
    const mode = payfastMode();
    const isSandbox = mode === 'sandbox';

    // PayFast's public sandbox merchant is only a fallback in sandbox mode
    if (!isSandbox && (!process.env.PAYFAST_MERCHANT_ID || !process.env.PAYFAST_MERCHANT_KEY)) {
        throw new Error('PayFast is in live mode but PAYFAST_MERCHANT_ID / PAYFAST_MERCHANT_KEY are not set');
    }
    const merchantId = process.env.PAYFAST_MERCHANT_ID || '10045256';
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || '2ib6bssct5vzd';
    const passPhrase = process.env.PAYFAST_PASSPHRASE || "";

    const frontendUrl = (process.env.BASE_URL || process.env.FRONTEND_URL || 'https://shipday-fe.vercel.app').trim().replace(/\/+$/, '');
    const finalBackendUrl = apiBaseUrl();

    // SAFETY: PayFast CloudFront blocks requests with "localhost" in ANY field.
    // If API_URL is still localhost, we need a valid production fallback or it will fail.
    if (finalBackendUrl.includes('localhost')) {
        console.warn('⚠️ PayFast: API_URL contains localhost. This will FAIL in production.');
    }

    // Construct data in the EXACT order expected/sent
    const data = {
        merchant_id: merchantId.trim(),
        merchant_key: merchantKey.trim(),
        return_url: `${frontendUrl}/payment/success`.trim(),
        cancel_url: `${frontendUrl}/payment/cancel`.trim(),
        notify_url: `${finalBackendUrl}/payments/notify`.trim(),
        name_first: shipment.senderDetails.fullName.split(' ')[0].trim(),
        name_last: (shipment.senderDetails.fullName.split(' ').slice(1).join(' ') || 'Sender').trim(),
        email_address: isSandbox ? 'sbtester@payfast.co.za' : shipment.senderDetails.email.trim(),
        m_payment_id: shipment.shipmentId.trim(),
        amount: shipment.payment.amount.toFixed(2),
        item_name: `Shipment ${shipment.shipmentId}`.trim(),
        item_description: `${shipment.parcelDetails.serviceType} delivery`.trim()
    };

    // Generate Signature
    data.signature = pfValidSignature(data, passPhrase);

    const payfastUrl = isSandbox
        ? 'https://sandbox.payfast.co.za/eng/process'
        : 'https://www.payfast.co.za/eng/process';

    console.log(`🚀 PayFast [${mode.toUpperCase()}]: Redirecting Shipment ${data.m_payment_id} to ${payfastUrl}`);

    return {
        url: payfastUrl,
        data
    };
};

// PayFast sends notifications only from these addresses (PayFast developer docs),
// plus whatever its host names currently resolve to
const PAYFAST_RANGES = [
    ['197.97.145.144', 28],
    ['41.74.179.192', 27],
    ['102.216.36.0', 28],
    ['102.216.36.128', 28],
    ['144.126.193.139', 32],
];
const PAYFAST_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
const inRange = (ip, [base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
};

const isPayFastIp = async (rawIp) => {
    const ip = String(rawIp || '').replace(/^::ffff:/, '');
    if (!net.isIPv4(ip)) return false;
    if (PAYFAST_RANGES.some((range) => inRange(ip, range))) return true;
    const resolved = await Promise.all(PAYFAST_HOSTS.map((host) => dns.resolve4(host).catch(() => [])));
    return resolved.flat().includes(ip);
};

// The notification's fields in the order received, without the signature
const pfParamString = (data) => Object.keys(data)
    .filter((key) => key !== 'signature')
    .map((key) => `${key}=${encodeURIComponent(String(data[key] ?? '').trim()).replace(/%20/g, '+')}`)
    .join('&');

// Ask PayFast itself whether it sent this notification
const confirmWithPayFast = async (data) => {
    const response = await fetch(`https://${payfastHost()}/eng/query/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pfParamString(data),
    });
    const text = (await response.text()).trim();
    return response.ok && text === 'VALID';
};

module.exports = {
    pfValidSignature,
    generatePaymentData,
    payfastMode,
    apiBaseUrl,
    isPayFastIp,
    confirmWithPayFast,
};
