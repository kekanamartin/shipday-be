// controllers/paymentController.js
const Notification = require('../models/Notification');

const Stripe = require('stripe');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? Stripe(stripeSecretKey) : null;

if (!stripe) {
  console.warn('⚠️ STRIPE_SECRET_KEY is missing. Stripe payments will not work.');
}
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { refreshCustomerActivation } = require('../services/marketingActivationService');
const { canAccessShipment, isStaff } = require('../middleware/access');

exports.createPaymentIntent = async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user._id;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Amount is required and must be a number' });
    }

    const customer = await stripe.customers.create();

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2022-11-15' } // or latest Stripe version you're using
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // Stripe expects amount in paise (INR)
      currency: 'inr',
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
    });

    console.log("🔁 Stripe Payment Init:", {
      customerId: customer.id,
      clientSecret: paymentIntent.client_secret,
      ephemeralKeySecret: ephemeralKey.secret,
    });
    await Notification.create({
      userId: userId || null,
      title: 'Payment Successful',
      message: `Your payment of ₹${amount} has been processed successfully.`,
      type: 'transactiom', // spelling fixed from 'transactiom'
    });

    res.status(200).json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error('Stripe Payment Error:', err);
    res.status(500).json({ error: 'Payment intent creation failed' });
  }
};

const { generatePaymentData, pfValidSignature, payfastMode, isPayFastIp, confirmWithPayFast } = require('../utils/payfast');
const mongoose = require('mongoose');

const toRand = (value) => Math.round(parseFloat(value) * 100) / 100;
const isDuplicateKey = (err) => err && err.code === 11000;

// A shipment by its database _id or its public shipment number
const findShipment = (id) => {
  const value = String(id || '').trim();
  if (!value) return null;
  return Shipment.findOne(mongoose.Types.ObjectId.isValid(value) ? { _id: value } : { shipmentId: value });
};

// Credit a PayFast top-up once. The Transaction (unique txnId) is written first,
// so a repeated notification for the same payment can't credit the wallet twice.
// Returns false if this payment was already recorded.
const creditTopUp = async ({ userId, amount, txnId, orderId, customer, description }) => {
  try {
    await Transaction.create({ txnId, customer, userId, type: 'Credit', orderId, amount, method: 'PayFast', status: 'Completed' });
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }

  try {
    await Wallet.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount }, $push: { transactions: { type: 'credit', amount, description, date: new Date() } } },
      { new: true, upsert: true }
    );
  } catch (err) {
    // Undo the record so PayFast's retry can try again
    await Transaction.deleteOne({ txnId }).catch(() => {});
    throw err;
  }

  await Notification.create({
    userId,
    title: 'Wallet Recharged',
    message: `R${amount.toFixed(2)} has been credited to your wallet.`,
    type: 'transaction'
  });
  await refreshCustomerActivation(userId);
  return true;
};

// Mark a shipment paid once. Returns the shipment, or null if it was already paid.
const markShipmentPaid = async (shipment, { amount, txnId, method, customer }) => {
  const updated = await Shipment.findOneAndUpdate(
    { _id: shipment._id, 'payment.status': { $ne: 'paid' } },
    { $set: { 'payment.status': 'paid', 'payment.transactionId': txnId, 'payment.amount': amount } },
    { new: true }
  );
  if (!updated) return null;

  const user = updated.customer
    ? await User.findById(updated.customer).select('_id')
    : await User.findOne({ email: updated.senderDetails?.email }).select('_id');

  await Transaction.create({
    txnId,
    customer: customer || updated.senderDetails?.fullName,
    userId: user?._id,
    type: 'Debit',
    orderId: updated.shipmentId,
    amount,
    method,
    status: 'Completed'
  }).catch((err) => { if (!isDuplicateKey(err)) throw err; });

  await Notification.create({
    userId: user ? user._id : null,
    title: 'Payment Received',
    message: `Payment of R${amount.toFixed(2)} received for Shipment ${updated.shipmentId}`,
    type: 'transaction'
  });
  return updated;
};

exports.initiatePayFastPayment = async (req, res) => {
  try {
    const { shipmentId } = req.body;

    if (!shipmentId) {
      return res.status(400).json({ message: 'Shipment ID is required' });
    }

    const shipment = await findShipment(shipmentId);
    if (!shipment || !canAccessShipment(req.user, shipment)) {
      return res.status(404).json({ message: 'Shipment not found' });
    }
    if (shipment.payment?.status === 'paid') {
      return res.status(400).json({ message: 'This shipment is already paid' });
    }

    const paymentInfo = generatePaymentData(shipment);

    // Construct Query String for GET redirect
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(paymentInfo.data)) {
      if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, value);
      }
    }

    const redirectUrl = `${paymentInfo.url}?${queryParams.toString()}`;

    res.status(200).json({
      redirectUrl,
      paymentId: paymentInfo.data.m_payment_id,
      paymentData: paymentInfo.data // Sending data just in case frontend wants to use form POST later
    });

  } catch (error) {
    console.error('PayFast Init Error:', error);
    res.status(500).json({ message: 'Failed to initiate PayFast payment', error: error.message });
  }
};

// Top up the signed-in user's own wallet
exports.initiateWalletTopup = async (req, res) => {
  try {
    const amount = toRand(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Enter an amount more than zero' });
    }

    const user = req.user;
    const paymentId = `TOPUP-${user._id}-${Date.now()}`;

    // Mocking shipment for PayFast generator
    const mockShipment = {
      shipmentId: paymentId,
      senderDetails: {
        fullName: user.fullName || 'ShipDay Customer',
        email: user.email
      },
      payment: { amount },
      parcelDetails: { serviceType: 'Wallet Top-up' }
    };

    const paymentInfo = generatePaymentData(mockShipment);

    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(paymentInfo.data)) {
      if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, value);
      }
    }

    res.status(200).json({
      redirectUrl: `${paymentInfo.url}?${queryParams.toString()}`,
      paymentId
    });

  } catch (error) {
    console.error('Top-up Init Error:', error);
    res.status(500).json({ message: 'Failed to initiate top-up', error: error.message });
  }
};

// PayFast's Instant Transaction Notification (ITN). Every check must pass before money moves:
// signature, sender address, merchant, PayFast's own confirmation, amount, and not already processed.
exports.handlePayFastNotify = async (req, res) => {
  try {
    const pfData = req.body || {};
    const reject = (reason) => {
      console.error(`❌ PayFast ITN rejected (${pfData.m_payment_id || 'no reference'}): ${reason}`);
      return res.status(400).send('Rejected');
    };

    const checkSignature = pfValidSignature(pfData, process.env.PAYFAST_PASSPHRASE);
    if (!pfData.signature || pfData.signature !== checkSignature) return reject('invalid signature');

    if (!(await isPayFastIp(req.ip))) return reject(`not sent from a PayFast address (${req.ip})`);

    const merchantId = (process.env.PAYFAST_MERCHANT_ID || '10045256').trim();
    if (String(pfData.merchant_id || '').trim() !== merchantId) return reject('wrong merchant');

    if (!(await confirmWithPayFast(pfData))) return reject('PayFast did not confirm the payment');

    const mPaymentId = String(pfData.m_payment_id || '');
    const amountGross = toRand(pfData.amount_gross);
    if (!Number.isFinite(amountGross) || amountGross <= 0) return reject('invalid amount');

    // Only completed payments move money; PayFast also notifies about cancelled/failed ones
    if (pfData.payment_status !== 'COMPLETE') return res.status(200).send('OK');

    if (mPaymentId.startsWith('TOPUP-')) {
      // WALLET TOPUP FLOW
      const userId = mPaymentId.split('-')[1];
      if (!mongoose.Types.ObjectId.isValid(userId) || !(await User.exists({ _id: userId }))) {
        return reject('unknown user');
      }
      await creditTopUp({
        userId,
        amount: amountGross,
        txnId: pfData.pf_payment_id,
        orderId: mPaymentId,
        customer: `${pfData.name_first || ''} ${pfData.name_last || ''}`.trim(),
        description: `Wallet Deposit via PayFast (Ref: ${pfData.pf_payment_id})`
      });
    } else {
      // SHIPMENT PAYMENT FLOW
      const shipment = await Shipment.findOne({ shipmentId: mPaymentId });
      if (!shipment) return reject('unknown shipment');
      if (Math.abs(toRand(shipment.payment?.amount) - amountGross) > 0.01) {
        return reject(`amount R${amountGross} does not match shipment total R${shipment.payment?.amount}`);
      }
      await markShipmentPaid(shipment, { amount: amountGross, txnId: pfData.pf_payment_id, method: 'PayFast' });
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('PayFast Notify Error:', err);
    res.status(500).send('Server Error');
  }
};

// Sandbox only: PayFast can't reach a local backend, so the success page confirms the payment itself.
// Never available unless PAYFAST_MODE is explicitly "sandbox".
exports.confirmSandboxPayment = async (req, res) => {
  try {
    if ((process.env.PAYFAST_MODE || '').trim().toLowerCase() !== 'sandbox' || payfastMode() !== 'sandbox') {
      return res.status(403).json({ message: 'Manual confirmation only allowed in sandbox mode' });
    }

    const mPaymentId = String(req.body.mPaymentId || '');

    if (mPaymentId.startsWith('TOPUP-')) {
      const userId = mPaymentId.split('-')[1];
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Invalid User ID structure' });
      }
      if (String(userId) !== String(req.user._id)) {
        return res.status(403).json({ message: 'You can only confirm your own top-up.' });
      }
      const amount = toRand(req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        return res.status(400).json({ message: 'Invalid amount' });
      }
      const credited = await creditTopUp({
        userId: req.user._id,
        amount,
        txnId: `MOCK-${mPaymentId}`, // Deterministic ID: confirming twice is a no-op
        orderId: mPaymentId,
        customer: req.user.fullName || req.user.email,
        description: 'Wallet Deposit (Sandbox)'
      });
      return res.status(200).json({ message: credited ? 'Sandbox payment synchronized successfully' : 'Sandbox payment already synchronized' });
    }

    const shipment = await findShipment(mPaymentId);
    if (!shipment || !canAccessShipment(req.user, shipment)) {
      return res.status(404).json({ message: 'Shipment not found' });
    }
    // The amount always comes from the shipment, never from the browser
    const paid = await markShipmentPaid(shipment, {
      amount: toRand(shipment.payment?.amount || 0),
      txnId: `MOCK-${shipment.shipmentId}`,
      method: 'PayFast'
    });
    res.status(200).json({ message: paid ? 'Sandbox payment synchronized successfully' : 'Sandbox payment already synchronized' });
  } catch (err) {
    console.error('❌ Sandbox Confirm Error:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// Pay for a shipment from an e-wallet. Customers always pay from their own wallet;
// staff paying on a customer's behalf use that shipment's customer's wallet.
exports.payWithWallet = async (req, res) => {
  try {
    const { shipmentId } = req.body;

    if (!shipmentId) {
      return res.status(400).json({ message: 'Shipment ID is required' });
    }

    const shipment = await findShipment(shipmentId);
    if (!shipment || !canAccessShipment(req.user, shipment)) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    if (shipment.payment.status === 'paid') {
      return res.status(400).json({ message: 'This shipment is already paid' });
    }

    let payerId = req.user._id;
    if (isStaff(req.user)) {
      const owner = shipment.customer
        ? await User.findById(shipment.customer).select('_id')
        : await User.findOne({ email: shipment.senderDetails?.email }).select('_id');
      if (!owner) return res.status(400).json({ message: "This shipment isn't linked to a customer account with a wallet" });
      payerId = owner._id;
    }

    const amount = toRand(shipment.payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: 'This shipment has no amount to pay' });
    }

    // Claim the shipment first so two clicks can't charge twice
    const transactionId = `WLT-${Date.now()}`;
    const claimed = await Shipment.findOneAndUpdate(
      { _id: shipment._id, 'payment.status': { $ne: 'paid' } },
      { $set: { 'payment.status': 'paid', 'payment.method': 'ewallet', 'payment.transactionId': transactionId } },
      { new: true }
    );
    if (!claimed) {
      return res.status(400).json({ message: 'This shipment is already paid' });
    }

    // Atomic: only debits while the balance covers the amount
    const updatedWallet = await Wallet.findOneAndUpdate(
      { userId: payerId, balance: { $gte: amount } },
      {
        $inc: { balance: -amount },
        $push: {
          transactions: {
            type: 'debit',
            amount,
            description: `Payment for Shipment ${shipment.shipmentId}`,
            date: new Date()
          }
        }
      },
      { new: true }
    );

    if (!updatedWallet) {
      // Release the shipment again
      await Shipment.updateOne(
        { _id: shipment._id, 'payment.transactionId': transactionId },
        { $set: { 'payment.status': shipment.payment.status || 'pending', 'payment.method': shipment.payment.method, 'payment.transactionId': shipment.payment.transactionId } }
      );
      return res.status(400).json({ message: 'Insufficient wallet balance' });
    }

    const newTransaction = new Transaction({
      txnId: transactionId,
      customer: shipment.senderDetails.fullName,
      userId: payerId, // Link to user account
      type: 'Debit',
      orderId: shipment.shipmentId,
      amount: amount,
      method: 'Wallet',
      status: 'Completed'
    });
    await newTransaction.save();

    // Push notification/record - non-blocking
    Notification.create({
      userId: payerId,
      title: 'Payment Successful',
      message: `Your payment of R${amount.toFixed(2)} for Shipment ${shipment.shipmentId} has been deducted from your wallet.`,
      type: 'transaction'
    }).catch(e => console.error("Async Notify Error:", e));

    res.status(200).json({
      message: 'Payment successful',
      transactionId,
      newBalance: updatedWallet.balance
    });

  } catch (error) {
    console.error('Wallet Payment Error:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
};
