const { body, query, validationResult } = require('express-validator');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

const emailBody = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  validate,
];

const codeBody = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('code').isString().isLength({ min: 3 }).withMessage('Code required'),
  validate,
];

const googleSigninBody = [
  body('token').isString().withMessage('Token required'),
  body('email').optional().isEmail().normalizeEmail(),
  validate,
];

module.exports = { emailBody, codeBody, googleSigninBody };
