const Wallet = require('../models/Wallet');
const mongoose = require('mongoose');
const { isSelfOrStaff } = require('../middleware/access');

//  Get wallet data
exports.getWallet = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }
    if (!isSelfOrStaff(req.user, req.params.userId)) {
      return res.status(403).json({ message: 'You can only view your own wallet.' });
    }
    let wallet = await Wallet.findOne({ userId: req.params.userId });

    // If wallet doesn't exist, create one automatically
    if (!wallet) {
      wallet = new Wallet({
        userId: req.params.userId,
        balance: 0,
        transactions: []
      });
      await wallet.save();
    } else {
      // Heal logic: Recalculate balance from history if they don't match (prevents sync issues)
      const calculatedBalance = wallet.transactions.reduce((acc, t) => {
        return t.type === 'credit' || t.type === 'Credit' ? acc + t.amount : acc - t.amount;
      }, 0);

      if (Math.abs(wallet.balance - calculatedBalance) > 0.01) {
        
        wallet.balance = calculatedBalance;
        await wallet.save();
      }
    }

    res.json(wallet);
  } catch (err) {
    console.error('Get Wallet Error:', err);
    res.status(500).json({ message: err.message });
  }
};

//  Add transaction and update balance (Atomic)
exports.addTransaction = async (req, res) => {
  try {
    const { userId, type, amount, description } = req.body;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'User ID is required' });
    }
    if (!['credit', 'debit'].includes(type)) {
      return res.status(400).json({ message: 'Type must be credit or debit' });
    }

    const objectUserId = new mongoose.Types.ObjectId(userId);
    const numAmount = Math.round(parseFloat(amount) * 100) / 100;
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ message: 'Amount must be more than zero' });
    }

    // Atomic: a debit only applies while the balance covers it
    const updatedWallet = await Wallet.findOneAndUpdate(
      type === 'debit' ? { userId: objectUserId, balance: { $gte: numAmount } } : { userId: objectUserId },
      {
        $inc: { balance: type === 'credit' ? numAmount : -numAmount },
        $push: {
          transactions: {
            type: type.toLowerCase(),
            amount: numAmount,
            description: description || `Balance update by ${req.user.fullName || req.user.email}`,
            date: new Date()
          }
        }
      },
      { new: true, upsert: type === 'credit' }
    );
    if (!updatedWallet) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Sync with Global Transactions
    try {
      const Transaction = require('../models/Transaction');
      const User = require('../models/User');
      const { v4: uuidv4 } = require('uuid');

      const user = await User.findById(objectUserId).select('fullName email');
      const customerName = user ? (user.fullName || user.email) : 'Unknown User';

      await Transaction.create({
        txnId: "TXN-WALLET-" + uuidv4().slice(0, 8).toUpperCase(),
        customer: customerName,
        userId: objectUserId,
        type: type === 'credit' ? 'Credit' : 'Debit',
        amount: numAmount,
        method: 'Wallet',
        status: 'Completed',
        orderId: description || 'Wallet Adjustment',
        date: new Date()
      });
      
    } catch (glErr) {
      console.error("Failed to sync global transaction:", glErr);
    }

    res.status(201).json(updatedWallet);
  } catch (err) {
    console.error('Add Transaction Error:', err);
    res.status(500).json({ message: err.message });
  }
};
