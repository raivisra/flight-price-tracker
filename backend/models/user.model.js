const { pool } = require('../db/connection');

class UserModel {
  // Create new user
  static async create(username, email, password_hash) {
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      [username, email, password_hash]
    );
    return result.rows[0];
  }

  // Find user by email
  static async findByEmail(email) {
    const result = await pool.query(
      `SELECT id, username, email, password_hash, is_active
       FROM users
       WHERE email = $1 AND is_active = true`,
      [email]
    );
    return result.rows[0];
  }

  // Find user by ID
  static async findById(id) {
    const result = await pool.query(
      `SELECT id, username, email, created_at, last_login
       FROM users
       WHERE id = $1 AND is_active = true`,
      [id]
    );
    return result.rows[0];
  }

  // Check if email exists
  static async emailExists(email) {
    const result = await pool.query(
      `SELECT COUNT(*) FROM users WHERE email = $1`,
      [email]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  // Update last login
  static async updateLastLogin(user_id) {
    await pool.query(
      `UPDATE users SET last_login = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [user_id]
    );
  }

  // Soft delete
  static async delete(user_id) {
    await pool.query(
      `UPDATE users SET deleted_at = NOW(), is_active = false
       WHERE id = $1`,
      [user_id]
    );
  }
}

module.exports = UserModel;
