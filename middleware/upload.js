const multer = require('multer');
const path = require('path');
const fs = require('fs');

/*
 * File uploads.
 *
 * Multer keeps each upload in memory, then `persist` stores it and sets `file.path`, which is the
 * only field the controllers read:
 *   - disk (default for a normal server): written under uploads/<folder>/, `file.path` = that path
 *   - inline (default on Vercel, whose file system is read-only): `file.path` = a data: URL saved
 *     in the database record, so the file still works without any file storage service
 * Set FILE_STORAGE=disk or FILE_STORAGE=inline to choose explicitly.
 *
 * Note: Vercel rejects request bodies over 4.5 MB, so uploads larger than that fail there.
 */
const useInlineStorage = () =>
  (process.env.FILE_STORAGE || (process.env.VERCEL ? 'inline' : 'disk')).toLowerCase() === 'inline';

const uniqueName = (prefix, originalname) =>
  `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(originalname || '')}`;

// Where each form field is stored and how it is named on disk
const FIELD_RULES = {
  driverImage: { dir: 'uploads/driver-images', prefix: 'driver-image' },
  idProof: { dir: 'uploads/id-proofs', prefix: 'id-proof' },
  supportingDocument: { dir: 'uploads/wallet-supporting-documents', prefix: 'wallet-support' },
};
const podRule = (field) => ({ dir: 'uploads/pod', prefix: `pod-${field}` });

const saveFile = async (file, rule) => {
  if (useInlineStorage()) {
    file.path = `data:${file.mimetype || 'application/octet-stream'};base64,${file.buffer.toString('base64')}`;
    file.filename = uniqueName(rule.prefix, file.originalname);
    return;
  }
  await fs.promises.mkdir(rule.dir, { recursive: true });
  const filename = uniqueName(rule.prefix, file.originalname);
  const filePath = path.join(rule.dir, filename);
  await fs.promises.writeFile(filePath, file.buffer);
  file.path = filePath;
  file.filename = filename;
  file.destination = rule.dir;
};

// Runs after multer and stores every file it received
const persist = (ruleFor) => async (req, res, next) => {
  try {
    const files = [];
    if (req.file) files.push(req.file);
    if (req.files) {
      Object.values(Array.isArray(req.files) ? { files: req.files } : req.files).forEach((list) => files.push(...list));
    }
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await saveFile(file, ruleFor(file.fieldname));
    }
    next();
  } catch (err) {
    next(err);
  }
};

const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed!'), false);
};

const walletSupportFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
  ];
  if (allowedMimeTypes.some((type) => file.mimetype.startsWith(type))) cb(null, true);
  else cb(new Error('Only image, PDF, Word, Excel, and text files are allowed!'), false);
};

const memory = multer.memoryStorage();
const defaultRule = (field) => FIELD_RULES[field] || FIELD_RULES.idProof;

// Same interface as a multer instance (.single / .fields / .array), each returning [multer, persist]
const withPersist = (instance, ruleFor) => ({
  single: (name) => [instance.single(name), persist(ruleFor)],
  fields: (fields) => [instance.fields(fields), persist(ruleFor)],
  array: (name, max) => [instance.array(name, max), persist(ruleFor)],
});

const upload = withPersist(
  multer({ storage: memory, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } }),
  defaultRule
);

const walletSupportUpload = withPersist(
  multer({ storage: memory, fileFilter: walletSupportFileFilter, limits: { fileSize: 10 * 1024 * 1024 } }),
  () => FIELD_RULES.supportingDocument
);

const podUpload = withPersist(
  multer({ storage: memory, limits: { fileSize: 10 * 1024 * 1024 } }),
  podRule
);

// Driver registration: driver photo + ID proof
const driverRegistrationUpload = upload.fields([
  { name: 'driverImage', maxCount: 1 },
  { name: 'idProof', maxCount: 1 },
]);

module.exports = { upload, podUpload, driverRegistrationUpload, walletSupportUpload };
