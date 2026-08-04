const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserModel = require('../models/user.model');
const { validateEmail, validatePassword } = require('../utils/validators');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_production';
const SALT_ROUNDS = 10;

class AuthService {
  // Register new user
  static async register(username, email, password, password_confirm) {
    // Validation
    if (!username || !email || !password) {
      throw { status: 400, message: 'Missing required fields' };
    }

    if (!validateEmail(email)) {
      throw { status: 400, message: 'Invalid email format' };
    }

    if (!validatePassword(password)) {
      throw {
        status: 400,
        message: 'Password must be at least 8 characters with uppercase, lowercase, and number'
      };
    }

    if (password !== password_confirm) {
      throw { status: 400, message: 'Passwords do not match' };
    }

    // Check if email exists
    if (await UserModel.emailExists(email)) {
      throw { status: 409, message: 'Email already exists' };
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const user = await UserModel.create(username, email, password_hash);

    // Generate token
    const token = this._generateToken(user.id, user.email);

    return { user, token };
  }

  // Login user
  static async login(email, password) {
    if (!email || !password) {
      throw { status: 400, message: 'Email and password required' };
    }

    // Find user
    const user = await UserModel.findByEmail(email);
    if (!user) {
      throw { status: 401, message: 'Invalid email or password' };
    }

    // Verify password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      throw { status: 401, message: 'Invalid email or password' };
    }

    // Update last login
    await UserModel.updateLastLogin(user.id);

    // Generate token
    const token = this._generateToken(user.id, user.email);

    return {
      user: { id: user.id, email: user.email },
      token
    };
  }

  // Verify JWT token
  static verifyToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded;
    } catch (error) {
      throw { status: 401, message: 'Invalid or expired token' };
    }
  }

  // Generate JWT token
  static _generateToken(user_id, email) {
    return jwt.sign({ user_id, email }, JWT_SECRET, { expiresIn: '7d' });
  }

  // Logout (frontend removes token)
  static logout() {
    return { message: 'Logout successful' };
  }
}

module.exports = AuthService;
