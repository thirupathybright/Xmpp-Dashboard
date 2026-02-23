# Marketing Person Assignment Feature

## Overview
This feature allows you to restrict data access in the AI chatbot based on marketing person assignments. Users can only view orders that belong to their assigned marketing person.

## How It Works

### 1. **Data Storage**
- Marketing person assignments are stored in `marketing_person_assignments.json`
- Format: `{ "assignments": { "user@domain": "marketing_person_name" } }`

### 2. **Database Integration**
- Fetches unique marketing persons from `database_orderregister.marketing_person` field
- Filters SQL queries to only show orders matching the user's assigned marketing person

### 3. **Security Filter**
When a user asks about orders:
- ✅ **User assigned to "John Doe"**: Only sees orders where `marketing_person = 'John Doe'`
- ❌ **User assigned to "Jane Smith"**: Cannot see John Doe's orders
- ⚠️ **User not assigned**: Sees all orders (no filter applied)

## Dashboard Features

### Marketing Person Management Section
1. **Load Marketing Person Data** button - Fetches data from database
2. **Available Marketing Persons** - Shows all unique marketing persons from database
3. **Assignment Table** - Shows all users with dropdown to assign marketing persons

### User Actions
- **Assign**: Select marketing person from dropdown for any user
- **Remove**: Click "Remove" button to clear assignment
- **View**: See current assignments in real-time

## API Endpoints

### GET `/marketing-persons`
Fetch all unique marketing persons from database
```json
{
  "success": true,
  "count": 5,
  "marketingPersons": ["John Doe", "Jane Smith", "Bob Johnson", ...]
}
```

### GET `/marketing-persons/assignments`
Get all current assignments
```json
{
  "success": true,
  "assignments": {
    "user1@domain": "John Doe",
    "user2@domain": "Jane Smith"
  },
  "users": ["user1@domain", "user2@domain", "user3@domain"]
}
```

### POST `/marketing-persons/assign`
Assign marketing person to a user
```json
{
  "userJid": "user1@domain",
  "marketingPerson": "John Doe"
}
```

### POST `/marketing-persons/remove`
Remove marketing person assignment
```json
{
  "userJid": "user1@domain"
}
```

### GET `/marketing-persons/user/:userJid`
Get marketing person for specific user
```json
{
  "success": true,
  "userJid": "user1@domain",
  "marketingPerson": "John Doe"
}
```

## Technical Implementation

### Files Modified
1. **marketingPersonStore.js** (NEW)
   - JSON-based storage for assignments
   - CRUD operations for marketing person assignments

2. **wpp/config/databaseHelper.js**
   - Added `getUniqueMarketingPersons()` method
   - Fetches distinct marketing persons from database

3. **wpp/config/sqlAgent.js**
   - Modified `queryFromNaturalLanguage()` to accept `marketingPerson` parameter
   - Automatically adds `WHERE marketing_person = 'X'` to all SQL queries

4. **aiHelper.js**
   - Fetches marketing person for user from store
   - Passes marketing person to SQL Agent for filtering
   - Logs security filters in console

5. **server.js**
   - Added 5 new API endpoints for marketing person management
   - Imported DatabaseHelper and MarketingPersonStore

6. **views/index.ejs**
   - Added new "Marketing Person Assignments" card
   - Interactive UI for assigning/removing marketing persons
   - Real-time updates without page refresh

## Usage Example

### Scenario 1: Assign User to Marketing Person
1. Open dashboard at http://localhost:3005
2. Scroll to "Marketing Person Assignments" section
3. Click "Load Marketing Person Data"
4. For user `john@chat.thirupathybright.in`:
   - Select "Rajesh Kumar" from dropdown
   - Assignment is saved automatically

### Scenario 2: User Queries Orders
**User:** `john@chat.thirupathybright.in` (assigned to "Rajesh Kumar")
**Query:** "Show me all pending orders"

**Behind the scenes:**
1. AI chatbot receives message
2. `aiHelper.js` looks up john's marketing person → "Rajesh Kumar"
3. SQL Agent generates query with filter:
   ```sql
   SELECT * FROM database_orderregister
   WHERE status = 'pending' AND marketing_person = 'Rajesh Kumar'
   ```
4. User only sees Rajesh Kumar's orders

### Scenario 3: Unassigned User
**User:** `admin@chat.thirupathybright.in` (no assignment)
**Query:** "Show all orders"

**Behind the scenes:**
1. No marketing person assigned
2. Query runs without filter:
   ```sql
   SELECT * FROM database_orderregister
   ```
3. User sees ALL orders (admin access)

## Security Benefits

✅ **Data Isolation**: Users can't access other marketing persons' data
✅ **Automatic Filtering**: No manual intervention needed
✅ **Audit Trail**: All assignments logged in JSON file
✅ **Flexible**: Easy to assign/unassign users
✅ **Database-Driven**: Marketing persons come from actual database

## Logging

Console logs show security context:
```
🔒 User john@chat.thirupathybright.in assigned to marketing person: Rajesh Kumar
🤖 Processing natural language query: "Show pending orders" [Marketing Person: Rajesh Kumar]
📝 Generated SQL:
SELECT * FROM database_orderregister
WHERE status = 'pending' AND marketing_person = 'Rajesh Kumar'
```

## Troubleshooting

### Issue: User sees all data instead of filtered data
**Solution**: Check `marketing_person_assignments.json` - ensure user is assigned

### Issue: No marketing persons showing in dashboard
**Solution**: Check database - ensure `database_orderregister.marketing_person` field has data

### Issue: Assignment not saving
**Solution**: Check file permissions on `marketing_person_assignments.json`

## Future Enhancements

- [ ] Bulk assignment feature
- [ ] Role-based access (admin vs user)
- [ ] Assignment history/audit log
- [ ] Auto-assign based on user attributes
- [ ] Multi-marketing person support (user can see multiple)
