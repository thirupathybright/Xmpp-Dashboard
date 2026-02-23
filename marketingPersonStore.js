// Marketing Person Assignment Store - Maps XMPP users to marketing persons
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'marketing_person_assignments.json');

class MarketingPersonStore {
  // Initialize store file if it doesn't exist
  static init() {
    if (!fs.existsSync(STORE_FILE)) {
      fs.writeFileSync(STORE_FILE, JSON.stringify({ assignments: {} }, null, 2));
      console.log('✅ Marketing person assignments store created');
    }
  }

  // Read assignments from file
  static readAssignments() {
    try {
      if (!fs.existsSync(STORE_FILE)) {
        this.init();
      }
      const data = fs.readFileSync(STORE_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('❌ Error reading marketing person assignments:', error);
      return { assignments: {} };
    }
  }

  // Write assignments to file
  static writeAssignments(data) {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
      console.log('✅ Marketing person assignments saved');
    } catch (error) {
      console.error('❌ Error writing marketing person assignments:', error);
    }
  }

  // Get marketing persons for a user (returns array)
  static getMarketingPersons(userJid) {
    const data = this.readAssignments();
    const assignment = data.assignments[userJid];

    // Handle backward compatibility - convert string to array
    if (!assignment) return [];
    if (Array.isArray(assignment)) return assignment;
    return [assignment]; // Convert old string format to array
  }

  // Get marketing person for a user (legacy - returns first one or null)
  static getMarketingPerson(userJid) {
    const persons = this.getMarketingPersons(userJid);
    return persons.length > 0 ? persons[0] : null;
  }

  // Set marketing persons for a user (accepts string or array)
  static setMarketingPersons(userJid, marketingPersons) {
    const data = this.readAssignments();

    // Convert to array if single string provided
    const personsArray = Array.isArray(marketingPersons) ? marketingPersons : [marketingPersons];

    // Filter out empty values
    const cleanArray = personsArray.filter(p => p && p.trim());

    if (cleanArray.length > 0) {
      data.assignments[userJid] = cleanArray;
      this.writeAssignments(data);
      console.log(`✅ Assigned ${cleanArray.join(', ')} to ${userJid}`);
    } else {
      // If empty array, remove assignment
      this.removeMarketingPerson(userJid);
    }
  }

  // Legacy method - set single marketing person
  static setMarketingPerson(userJid, marketingPerson) {
    this.setMarketingPersons(userJid, [marketingPerson]);
  }

  // Add a marketing person to user's list
  static addMarketingPerson(userJid, marketingPerson) {
    const current = this.getMarketingPersons(userJid);
    if (!current.includes(marketingPerson)) {
      current.push(marketingPerson);
      this.setMarketingPersons(userJid, current);
    }
  }

  // Remove a specific marketing person from user's list
  static removeMarketingPersonFromList(userJid, marketingPerson) {
    const current = this.getMarketingPersons(userJid);
    const filtered = current.filter(p => p !== marketingPerson);

    if (filtered.length === 0) {
      this.removeMarketingPerson(userJid);
    } else {
      this.setMarketingPersons(userJid, filtered);
    }
  }

  // Remove marketing person assignment for a user
  static removeMarketingPerson(userJid) {
    const data = this.readAssignments();
    if (data.assignments[userJid]) {
      delete data.assignments[userJid];
      this.writeAssignments(data);
      console.log(`✅ Removed marketing person assignment for ${userJid}`);
      return true;
    }
    return false;
  }

  // Get all assignments
  static getAllAssignments() {
    const data = this.readAssignments();
    return data.assignments;
  }

  // Get all users assigned to a specific marketing person
  static getUsersByMarketingPerson(marketingPerson) {
    const data = this.readAssignments();
    const users = [];
    for (const [userJid, mp] of Object.entries(data.assignments)) {
      if (mp === marketingPerson) {
        users.push(userJid);
      }
    }
    return users;
  }
}

// Initialize on module load
MarketingPersonStore.init();

module.exports = MarketingPersonStore;
