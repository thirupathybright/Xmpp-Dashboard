// JSON-based Chat Memory Storage for AI Mode - Per-User Files
const fs = require('fs');
const path = require('path');

const CHAT_MEMORY_DIR = path.join(__dirname, '..', 'chat_memory');

class ChatMemoryStore {
  // Initialize storage directory
  static init() {
    if (!fs.existsSync(CHAT_MEMORY_DIR)) {
      fs.mkdirSync(CHAT_MEMORY_DIR, { recursive: true });
      console.log('📁 Created chat_memory directory');
    }
  }

  // Get file path for a user
  static getUserFilePath(phoneNumber) {
    return path.join(CHAT_MEMORY_DIR, `${phoneNumber}.json`);
  }

  // Read conversation for a specific user
  static readUserConversation(phoneNumber) {
    try {
      const filePath = this.getUserFilePath(phoneNumber);
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data).messages || [];
    } catch (error) {
      console.error(`Error reading chat for ${phoneNumber}:`, error);
      return [];
    }
  }

  // Write conversation for a specific user
  static writeUserConversation(phoneNumber, messages) {
    try {
      const filePath = this.getUserFilePath(phoneNumber);
      const data = {
        phoneNumber: phoneNumber,
        messageCount: messages.length,
        lastUpdated: new Date().toISOString(),
        messages: messages
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`Error writing chat for ${phoneNumber}:`, error);
    }
  }

  // Get list of all user phone numbers
  static getAllUserNumbers() {
    try {
      if (!fs.existsSync(CHAT_MEMORY_DIR)) {
        return [];
      }
      const files = fs.readdirSync(CHAT_MEMORY_DIR);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
    } catch (error) {
      console.error('Error reading chat_memory directory:', error);
      return [];
    }
  }

  // Get conversation history for a user
  static getHistory(phoneNumber) {
    return this.readUserConversation(phoneNumber);
  }

  // Add message to conversation history
  static addMessage(phoneNumber, role, content) {
    const messages = this.readUserConversation(phoneNumber);

    // Add new message
    messages.push({
      role: role,
      content: content,
      timestamp: Date.now(),
      createdAt: new Date().toISOString()
    });

    // Keep only last 10 messages (5 exchanges)
    if (messages.length > 10) {
      messages.splice(0, messages.length - 10);
    }

    this.writeUserConversation(phoneNumber, messages);

    // Return messages in API format (without timestamp)
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  // Clear conversation history for a user
  static clearHistory(phoneNumber) {
    try {
      const filePath = this.getUserFilePath(phoneNumber);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return true;
    } catch (error) {
      console.error(`Error clearing history for ${phoneNumber}:`, error);
      return false;
    }
  }

  // Clear all conversation history
  static clearAllHistory() {
    try {
      const userNumbers = this.getAllUserNumbers();
      userNumbers.forEach(phoneNumber => {
        this.clearHistory(phoneNumber);
      });
      return true;
    } catch (error) {
      console.error('Error clearing all history:', error);
      return false;
    }
  }

  // Get statistics
  static getStats() {
    try {
      const userNumbers = this.getAllUserNumbers();
      const stats = {
        totalUsers: userNumbers.length,
        users: []
      };

      userNumbers.forEach(phoneNumber => {
        const filePath = this.getUserFilePath(phoneNumber);
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          const messages = data.messages || [];
          stats.users.push({
            phone: phoneNumber,
            messageCount: messages.length,
            lastMessageAt: messages.length > 0
              ? messages[messages.length - 1].createdAt
              : null
          });
        }
      });

      // Sort by last message time
      stats.users.sort((a, b) => {
        if (!a.lastMessageAt) return 1;
        if (!b.lastMessageAt) return -1;
        return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
      });

      return stats;
    } catch (error) {
      console.error('Error getting stats:', error);
      return { totalUsers: 0, users: [] };
    }
  }

  // Get conversation details for a specific user
  static getConversation(phoneNumber) {
    return this.readUserConversation(phoneNumber);
  }

  // Cleanup old conversations (older than specified days)
  static cleanup(olderThanDays = 7) {
    try {
      const userNumbers = this.getAllUserNumbers();
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
      let deletedCount = 0;

      userNumbers.forEach(phoneNumber => {
        const messages = this.readUserConversation(phoneNumber);
        if (messages.length > 0) {
          const lastMessageTime = messages[messages.length - 1].timestamp;
          if (lastMessageTime < cutoffTime) {
            this.clearHistory(phoneNumber);
            deletedCount++;
          }
        }
      });

      return deletedCount;
    } catch (error) {
      console.error('Error during cleanup:', error);
      return 0;
    }
  }
}

// Initialize on module load
ChatMemoryStore.init();

module.exports = ChatMemoryStore;
