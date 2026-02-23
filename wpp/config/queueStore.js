// JSON-based Queue Storage
const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '..', 'message_queue.json');

class QueueStore {
  // Initialize storage file
  static init() {
    if (!fs.existsSync(QUEUE_FILE)) {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify({ queue: [] }, null, 2));
      console.log('📄 Created message_queue.json file');
    }
  }

  // Read queue from JSON file
  static readQueue() {
    try {
      const data = fs.readFileSync(QUEUE_FILE, 'utf8');
      return JSON.parse(data).queue || [];
    } catch (error) {
      console.error('Error reading message_queue.json:', error);
      return [];
    }
  }

  // Write queue to JSON file
  static writeQueue(queue) {
    try {
      fs.writeFileSync(QUEUE_FILE, JSON.stringify({ queue }, null, 2));
    } catch (error) {
      console.error('Error writing message_queue.json:', error);
    }
  }

  // Add message to queue
  static addMessage(phone, message, feature = null) {
    const queue = this.readQueue();
    const queueItem = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      phone,
      message,
      feature,
      timestamp: Date.now(),
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    queue.push(queueItem);
    this.writeQueue(queue);

    return queueItem;
  }

  // Get all pending messages
  static getPendingMessages() {
    const queue = this.readQueue();
    return queue.filter(item => item.status === 'pending');
  }

  // Get first pending message
  static getFirstPending() {
    const pending = this.getPendingMessages();
    return pending.length > 0 ? pending[0] : null;
  }

  // Update message status
  static updateMessageStatus(messageId, status, result = null) {
    const queue = this.readQueue();
    const index = queue.findIndex(item => item.id === messageId);

    if (index >= 0) {
      queue[index].status = status;
      queue[index].updatedAt = new Date().toISOString();

      if (result) {
        queue[index].result = result;
      }

      this.writeQueue(queue);
      return true;
    }

    return false;
  }

  // Delete message from queue
  static deleteMessage(messageId) {
    const queue = this.readQueue();
    const filtered = queue.filter(item => item.id !== messageId);
    this.writeQueue(filtered);
    return true;
  }

  // Get queue length
  static getQueueLength() {
    return this.getPendingMessages().length;
  }

  // Clear all completed/failed messages older than specified time (in milliseconds)
  static cleanup(olderThan = 3600000) { // Default: 1 hour
    const queue = this.readQueue();
    const now = Date.now();

    const filtered = queue.filter(item => {
      // Keep pending messages
      if (item.status === 'pending') return true;

      // Remove old completed/failed messages
      const age = now - item.timestamp;
      return age < olderThan;
    });

    this.writeQueue(filtered);
    return queue.length - filtered.length; // Return number of deleted items
  }

  // Get queue statistics
  static getStats() {
    const queue = this.readQueue();
    return {
      total: queue.length,
      pending: queue.filter(item => item.status === 'pending').length,
      processing: queue.filter(item => item.status === 'processing').length,
      completed: queue.filter(item => item.status === 'completed').length,
      failed: queue.filter(item => item.status === 'failed').length
    };
  }

  // Clear entire queue
  static clearAll() {
    this.writeQueue([]);
    return true;
  }
}

// Initialize on module load
QueueStore.init();

module.exports = QueueStore;
