// Session Database Helper
const db = require('./db');

class SessionDB {
  // Save or update session
  static saveSession(sessionId, phoneNumber = null, status = 'connecting') {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO whatsapp_sessions (session_id, phone_number, status, connected_at)
        VALUES (?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          phone_number = VALUES(phone_number),
          status = VALUES(status),
          connected_at = NOW()
      `;

      db.query(sql, [sessionId, phoneNumber, status], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // Get session by ID
  static getSession(sessionId) {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM whatsapp_sessions WHERE session_id = ?';

      db.query(sql, [sessionId], (err, results) => {
        if (err) reject(err);
        else resolve(results[0] || null);
      });
    });
  }

  // Get all sessions
  static getAllSessions() {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM whatsapp_sessions ORDER BY created_at DESC';

      db.query(sql, (err, results) => {
        if (err) reject(err);
        else resolve(results || []);
      });
    });
  }

  // Update session assignments
  static updateAssignments(sessionId, assignments) {
    return new Promise((resolve, reject) => {
      const sql = `
        UPDATE whatsapp_sessions
        SET
          ot_message_enabled = ?,
          checkin_checkout_enabled = ?,
          group_message_enabled = ?,
          pc_automation_enabled = ?
        WHERE session_id = ?
      `;

      db.query(sql, [
        assignments.ot_message_enabled ? 1 : 0,
        assignments.checkin_checkout_enabled ? 1 : 0,
        assignments.group_message_enabled ? 1 : 0,
        assignments.pc_automation_enabled ? 1 : 0,
        sessionId
      ], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // Get session for specific feature
  static getSessionForFeature(featureName) {
    return new Promise((resolve, reject) => {
      const featureMap = {
        'ot_message': 'ot_message_enabled',
        'checkin_checkout': 'checkin_checkout_enabled',
        'group_message': 'group_message_enabled',
        'pc_automation': 'pc_automation_enabled'
      };

      const column = featureMap[featureName];
      if (!column) {
        return reject(new Error(`Invalid feature: ${featureName}`));
      }

      const sql = `
        SELECT * FROM whatsapp_sessions
        WHERE ${column} = 1 AND status = 'connected'
        LIMIT 1
      `;

      db.query(sql, (err, results) => {
        if (err) reject(err);
        else resolve(results[0] || null);
      });
    });
  }

  // Delete session
  static deleteSession(sessionId) {
    return new Promise((resolve, reject) => {
      const sql = 'DELETE FROM whatsapp_sessions WHERE session_id = ?';

      db.query(sql, [sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // Update session status
  static updateStatus(sessionId, status) {
    return new Promise((resolve, reject) => {
      const sql = 'UPDATE whatsapp_sessions SET status = ? WHERE session_id = ?';

      db.query(sql, [status, sessionId], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
}

module.exports = SessionDB;
