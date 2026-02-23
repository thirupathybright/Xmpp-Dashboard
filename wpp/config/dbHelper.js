// Database Helper Functions for WhatsApp Session Management
const db = require('./db');

class DBHelper {
  // ========== SESSION MANAGEMENT ==========

  /**
   * Create a new session in the database
   */
  static async createSession(sessionId) {
    const sql = `
      INSERT INTO whatsapp_sessions (session_id, status)
      VALUES (?, 'connecting')
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId], (err, result) => {
        if (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            // Session already exists, just return success
            resolve({ sessionId, alreadyExists: true });
          } else {
            reject(err);
          }
        } else {
          resolve({ sessionId, id: result.insertId });
        }
      });
    });
  }

  /**
   * Update session status
   */
  static async updateSessionStatus(sessionId, status, phoneNumber = null) {
    let sql, params;

    if (phoneNumber) {
      sql = `
        UPDATE whatsapp_sessions
        SET status = ?, phone_number = ?, connected_at = NOW()
        WHERE session_id = ?
      `;
      params = [status, phoneNumber, sessionId];
    } else {
      sql = `
        UPDATE whatsapp_sessions
        SET status = ?
        WHERE session_id = ?
      `;
      params = [status, sessionId];
    }

    return new Promise((resolve, reject) => {
      db.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Update QR code for a session
   */
  static async updateQRCode(sessionId, qrCode) {
    const sql = `
      UPDATE whatsapp_sessions
      SET qr_code = ?, status = 'qr_received'
      WHERE session_id = ?
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [qrCode, sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Get session by session_id
   */
  static async getSession(sessionId) {
    const sql = 'SELECT * FROM whatsapp_sessions WHERE session_id = ?';

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId], (err, results) => {
        if (err) reject(err);
        else resolve(results[0] || null);
      });
    });
  }

  /**
   * Get all sessions
   */
  static async getAllSessions() {
    const sql = 'SELECT * FROM whatsapp_sessions ORDER BY created_at DESC';

    return new Promise((resolve, reject) => {
      db.query(sql, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  /**
   * Delete a session
   */
  static async deleteSession(sessionId) {
    const sql = 'DELETE FROM whatsapp_sessions WHERE session_id = ?';

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Update session assignment settings
   */
  static async updateSessionAssignments(sessionId, assignments) {
    const {
      ot_message_enabled,
      checkin_checkout_enabled,
      group_message_enabled,
      pc_automation_enabled
    } = assignments;

    const sql = `
      UPDATE whatsapp_sessions
      SET
        ot_message_enabled = ?,
        checkin_checkout_enabled = ?,
        group_message_enabled = ?,
        pc_automation_enabled = ?
      WHERE session_id = ?
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [
        ot_message_enabled ? 1 : 0,
        checkin_checkout_enabled ? 1 : 0,
        group_message_enabled ? 1 : 0,
        pc_automation_enabled ? 1 : 0,
        sessionId
      ], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Get session enabled for specific feature
   */
  static async getSessionForFeature(feature) {
    const featureColumn = {
      'ot_message': 'ot_message_enabled',
      'checkin_checkout': 'checkin_checkout_enabled',
      'group_message': 'group_message_enabled',
      'pc_automation': 'pc_automation_enabled'
    }[feature];

    if (!featureColumn) {
      throw new Error(`Invalid feature: ${feature}`);
    }

    const sql = `
      SELECT * FROM whatsapp_sessions
      WHERE ${featureColumn} = 1 AND status = 'connected'
      LIMIT 1
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, (err, results) => {
        if (err) reject(err);
        else resolve(results[0] || null);
      });
    });
  }

  /**
   * Update group count for a session
   */
  static async updateGroupCount(sessionId, count) {
    const sql = `
      UPDATE whatsapp_sessions
      SET group_count = ?
      WHERE session_id = ?
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [count, sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // ========== GROUP MANAGEMENT ==========

  /**
   * Save or update a group
   */
  static async saveGroup(sessionId, groupId, groupName, participantsCount) {
    const sql = `
      INSERT INTO whatsapp_groups (session_id, group_id, group_name, participants_count)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        group_name = VALUES(group_name),
        participants_count = VALUES(participants_count),
        updated_at = NOW()
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId, groupId, groupName, participantsCount], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Get all groups for a session
   */
  static async getGroupsForSession(sessionId) {
    const sql = 'SELECT * FROM whatsapp_groups WHERE session_id = ? ORDER BY group_name';

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId], (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  /**
   * Get all groups from all sessions
   */
  static async getAllGroups() {
    const sql = `
      SELECT
        g.*,
        s.phone_number as session_number
      FROM whatsapp_groups g
      JOIN whatsapp_sessions s ON g.session_id = s.session_id
      WHERE s.status = 'connected'
      ORDER BY g.group_name
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  /**
   * Delete all groups for a session
   */
  static async deleteGroupsForSession(sessionId) {
    const sql = 'DELETE FROM whatsapp_groups WHERE session_id = ?';

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // ========== MESSAGE LOGGING ==========

  /**
   * Log a message
   */
  static async logMessage(sessionId, phoneNumber, messageType, messageContent, status = 'queued') {
    const sql = `
      INSERT INTO message_logs (session_id, phone_number, message_type, message_content, status)
      VALUES (?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [sessionId, phoneNumber, messageType, messageContent, status], (err, result) => {
        if (err) reject(err);
        else resolve({ logId: result.insertId });
      });
    });
  }

  /**
   * Update message log status
   */
  static async updateMessageLog(logId, status, errorMessage = null) {
    const sql = `
      UPDATE message_logs
      SET status = ?, error_message = ?, sent_at = NOW()
      WHERE id = ?
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [status, errorMessage, logId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Get message logs with pagination
   */
  static async getMessageLogs(limit = 100, offset = 0) {
    const sql = `
      SELECT * FROM message_logs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    return new Promise((resolve, reject) => {
      db.query(sql, [limit, offset], (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }
}

module.exports = DBHelper;
