// JSON-based Session Storage
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'sessions.json');

class SessionStore {
  // Initialize storage file
  static init() {
    if (!fs.existsSync(SESSION_FILE)) {
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessions: [] }, null, 2));
      console.log('📄 Created sessions.json file');
    }
  }

  // Read all sessions from JSON file
  static readSessions() {
    try {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      return JSON.parse(data).sessions || [];
    } catch (error) {
      console.error('Error reading sessions.json:', error);
      return [];
    }
  }

  // Write sessions to JSON file
  static writeSessions(sessions) {
    try {
      const dataToWrite = JSON.stringify({ sessions }, null, 2);
      console.log(`💾 Writing to ${SESSION_FILE}`);
      fs.writeFileSync(SESSION_FILE, dataToWrite);
      console.log(`💾 Write successful! File size: ${dataToWrite.length} bytes`);
    } catch (error) {
      console.error('❌ Error writing sessions.json:', error);
    }
  }

  // Save or update session
  static saveSession(sessionId, phoneNumber = null, status = 'connecting') {
    const sessions = this.readSessions();
    const existingIndex = sessions.findIndex(s => s.session_id === sessionId);

    if (existingIndex >= 0) {
      // Update existing session
      sessions[existingIndex].phone_number = phoneNumber || sessions[existingIndex].phone_number;
      sessions[existingIndex].status = status;
      sessions[existingIndex].updated_at = new Date().toISOString();
      if (status === 'connected') {
        sessions[existingIndex].connected_at = new Date().toISOString();
      }
    } else {
      // Create new session
      sessions.push({
        session_id: sessionId,
        phone_number: phoneNumber,
        status: status,
        ot_message_enabled: false,
        checkin_checkout_enabled: false,
        group_message_enabled: false,
        pc_automation_enabled: false,
        delegation_enabled: false,
        helpticket_enabled: false,
        ai_mode_enabled: false,
        ncr_enabled: false,
        last_ot_reply: {},  // Track last OT reply per user: { "phoneNumber": timestamp }
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        connected_at: status === 'connected' ? new Date().toISOString() : null
      });
    }

    this.writeSessions(sessions);
    return sessions.find(s => s.session_id === sessionId);
  }

  // Get session by ID
  static getSession(sessionId) {
    const sessions = this.readSessions();
    return sessions.find(s => s.session_id === sessionId) || null;
  }

  // Get all sessions
  static getAllSessions() {
    return this.readSessions();
  }

  // Update session assignments
  static updateAssignments(sessionId, assignments) {
    console.log(`\n========== UPDATE ASSIGNMENTS DEBUG ==========`);
    console.log(`📥 Received sessionId: "${sessionId}"`);
    console.log(`📥 Received assignments:`, JSON.stringify(assignments));

    const sessions = this.readSessions();
    console.log(`📂 Total sessions in JSON: ${sessions.length}`);
    console.log(`📂 Session IDs in JSON:`, sessions.map(s => s.session_id));

    const sessionIndex = sessions.findIndex(s => s.session_id === sessionId);
    console.log(`🔍 Found session at index: ${sessionIndex}`);

    if (sessionIndex >= 0) {
      console.log(`📋 BEFORE update:`, JSON.stringify(sessions[sessionIndex], null, 2));

      // Only update fields that are explicitly provided in assignments
      // This allows partial updates without resetting other fields
      if ('ot_message_enabled' in assignments) {
        const oldVal = sessions[sessionIndex].ot_message_enabled;
        sessions[sessionIndex].ot_message_enabled = Boolean(assignments.ot_message_enabled);
        console.log(`   ot_message_enabled: ${oldVal} -> ${sessions[sessionIndex].ot_message_enabled}`);
      }
      if ('checkin_checkout_enabled' in assignments) {
        sessions[sessionIndex].checkin_checkout_enabled = Boolean(assignments.checkin_checkout_enabled);
      }
      if ('group_message_enabled' in assignments) {
        sessions[sessionIndex].group_message_enabled = Boolean(assignments.group_message_enabled);
      }
      if ('pc_automation_enabled' in assignments) {
        sessions[sessionIndex].pc_automation_enabled = Boolean(assignments.pc_automation_enabled);
      }
      if ('delegation_enabled' in assignments) {
        sessions[sessionIndex].delegation_enabled = Boolean(assignments.delegation_enabled);
      }
      if ('helpticket_enabled' in assignments) {
        sessions[sessionIndex].helpticket_enabled = Boolean(assignments.helpticket_enabled);
      }
      if ('ai_mode_enabled' in assignments) {
        const oldVal = sessions[sessionIndex].ai_mode_enabled;
        sessions[sessionIndex].ai_mode_enabled = Boolean(assignments.ai_mode_enabled);
        console.log(`   ai_mode_enabled: ${oldVal} -> ${sessions[sessionIndex].ai_mode_enabled}`);
      }
      if ('ncr_enabled' in assignments) {
        const oldVal = sessions[sessionIndex].ncr_enabled;
        sessions[sessionIndex].ncr_enabled = Boolean(assignments.ncr_enabled);
        console.log(`   ncr_enabled: ${oldVal} -> ${sessions[sessionIndex].ncr_enabled}`);
      }

      sessions[sessionIndex].updated_at = new Date().toISOString();

      console.log(`📋 AFTER update:`, JSON.stringify(sessions[sessionIndex], null, 2));

      this.writeSessions(sessions);

      // Verify the write by reading back
      const verifyData = this.readSessions();
      const verifySession = verifyData.find(s => s.session_id === sessionId);
      console.log(`✅ VERIFY after write:`, JSON.stringify(verifySession, null, 2));
      console.log(`========== END UPDATE ASSIGNMENTS ==========\n`);

      return true;
    }

    console.log(`⚠️ Session ${sessionId} NOT FOUND for assignment update`);
    console.log(`========== END UPDATE ASSIGNMENTS ==========\n`);
    return false;
  }

  // Get session for specific feature
  static getSessionForFeature(featureName) {
    const featureMap = {
      'ot_message': 'ot_message_enabled',
      'checkin_checkout': 'checkin_checkout_enabled',
      'group_message': 'group_message_enabled',
      'pc_automation': 'pc_automation_enabled',
      'delegation': 'delegation_enabled',
      'helpticket': 'helpticket_enabled',
      'ai_mode': 'ai_mode_enabled',
      'ncr': 'ncr_enabled'
    };

    const field = featureMap[featureName];
    if (!field) {
      return null;
    }

    const sessions = this.readSessions();
    return sessions.find(s => s[field] === true && s.status === 'connected') || null;
  }

  // Get ALL sessions for a specific feature (supports multiple sessions per feature)
  static getAllSessionsForFeature(featureName) {
    const featureMap = {
      'ot_message': 'ot_message_enabled',
      'checkin_checkout': 'checkin_checkout_enabled',
      'group_message': 'group_message_enabled',
      'pc_automation': 'pc_automation_enabled',
      'delegation': 'delegation_enabled',
      'helpticket': 'helpticket_enabled',
      'ai_mode': 'ai_mode_enabled',
      'ncr': 'ncr_enabled'
    };

    const field = featureMap[featureName];
    if (!field) {
      return [];
    }

    const sessions = this.readSessions();
    return sessions.filter(s => s[field] === true && s.status === 'connected');
  }

  // Delete session
  static deleteSession(sessionId) {
    const sessions = this.readSessions();
    const filtered = sessions.filter(s => s.session_id !== sessionId);
    this.writeSessions(filtered);
    return true;
  }

  // Update session status
  static updateStatus(sessionId, status) {
    const sessions = this.readSessions();
    const sessionIndex = sessions.findIndex(s => s.session_id === sessionId);

    if (sessionIndex >= 0) {
      sessions[sessionIndex].status = status;
      sessions[sessionIndex].updated_at = new Date().toISOString();
      this.writeSessions(sessions);
      return true;
    }

    return false;
  }

  // Check if OT reply can be sent (1 per minute per user per session)
  static canSendOTReply(sessionId, phoneNumber) {
    const sessions = this.readSessions();
    const session = sessions.find(s => s.session_id === sessionId);

    if (!session || !session.last_ot_reply) {
      return true; // First time or no tracking
    }

    const lastReplyTime = session.last_ot_reply[phoneNumber];
    if (!lastReplyTime) {
      return true; // First time for this user
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000; // 60 seconds

    return lastReplyTime < oneMinuteAgo;
  }

  // Update last OT reply time for a user
  static updateOTReplyTime(sessionId, phoneNumber) {
    const sessions = this.readSessions();
    const sessionIndex = sessions.findIndex(s => s.session_id === sessionId);

    if (sessionIndex >= 0) {
      if (!sessions[sessionIndex].last_ot_reply) {
        sessions[sessionIndex].last_ot_reply = {};
      }

      sessions[sessionIndex].last_ot_reply[phoneNumber] = Date.now();
      sessions[sessionIndex].updated_at = new Date().toISOString();
      this.writeSessions(sessions);
      return true;
    }

    return false;
  }

  // Get time until next OT reply is allowed (in seconds)
  static getOTCooldown(sessionId, phoneNumber) {
    const sessions = this.readSessions();
    const session = sessions.find(s => s.session_id === sessionId);

    if (!session || !session.last_ot_reply || !session.last_ot_reply[phoneNumber]) {
      return 0; // No cooldown
    }

    const lastReplyTime = session.last_ot_reply[phoneNumber];
    const now = Date.now();
    const timeSinceLastReply = now - lastReplyTime;
    const remainingCooldown = 60000 - timeSinceLastReply; // 60 seconds cooldown

    return remainingCooldown > 0 ? Math.ceil(remainingCooldown / 1000) : 0;
  }
}

// Initialize on module load
SessionStore.init();

module.exports = SessionStore;
