// SQL Agent using LangChain for Natural Language to SQL
const mysql = require('mysql2/promise');
const DATABASES = require('./sqlAuthenticator');

// Create connection pool
let pool = null;

class SQLAgent {
  static init() {
    try {
      const dbConfig = DATABASES['default'];
      pool = mysql.createPool({
        host: dbConfig.HOST,
        port: dbConfig.PORT,
        user: dbConfig.USER,
        password: dbConfig.PASSWORD,
        database: dbConfig.NAME,
        connectionLimit: dbConfig.connectionLimit || 10,
        waitForConnections: dbConfig.waitForConnections !== false,
        queueLimit: dbConfig.queueLimit || 0
      });
      console.log('✅ SQL Agent pool initialized');
    } catch (error) {
      console.error('❌ SQL Agent pool initialization failed:', error);
    }
  }

  // Get database schema information
  static async getDatabaseSchema() {
    try {
      const schema = {
        database: 'thirupathybright',
        tables: {}
      };

      // Get all tables
      const tables = [
        'Database_orderregister',
        'mastercustomer',
        'Database_despatch',
        'Database_weightment',
        'Database_despatchinvoice'
      ];

      for (const tableName of tables) {
        const [columns] = await pool.execute(`DESCRIBE thirupathybright.${tableName}`);
        schema.tables[tableName] = {
          columns: columns.map(col => ({
            name: col.Field,
            type: col.Type,
            nullable: col.Null === 'YES',
            key: col.Key,
            default: col.Default
          }))
        };
      }

      return schema;
    } catch (error) {
      console.error('❌ Error getting database schema:', error);
      return null;
    }
  }

  // Execute SQL query with safety checks
  static async executeQuery(sql, params = []) {
    try {
      // Safety check - only allow SELECT queries
      const normalizedSQL = sql.trim().toUpperCase();
      if (!normalizedSQL.startsWith('SELECT')) {
        throw new Error('Only SELECT queries are allowed');
      }

      console.log(`🔍 Executing SQL: ${sql}`);
      if (params.length > 0) {
        console.log(`📋 Parameters:`, params);
      }

      const [rows] = await pool.execute(sql, params);

      console.log(`✅ Query returned ${rows.length} rows`);

      return {
        success: true,
        rows: rows,
        count: rows.length
      };
    } catch (error) {
      console.error('❌ SQL execution error:', error);
      return {
        success: false,
        error: error.message,
        rows: [],
        count: 0
      };
    }
  }

  // Look up customer IDs from mastercustomer by keyword (case-insensitive)
  static async lookupCustomerIds(keyword) {
    try {
      const [rows] = await pool.execute(
        `SELECT id, customer_name FROM thirupathybright.mastercustomer WHERE LOWER(customer_name) LIKE LOWER(?) LIMIT 20`,
        [`%${keyword}%`]
      );
      console.log(`🔍 Customer lookup for "${keyword}": found ${rows.length} match(es):`, rows.map(r => r.customer_name));
      return rows;
    } catch (error) {
      console.error('❌ Customer lookup error:', error);
      return [];
    }
  }

  // Find customer matches by trying each word of the question against the database
  // Returns { keyword, customers } for the first word that matches any customer
  static async findCustomerInQuestion(question) {
    // Words that are definitely not customer names - skip these
    const skipWords = new Set([
      'give', 'me', 'all', 'show', 'list', 'get', 'find', 'fetch', 'what',
      'are', 'is', 'was', 'were', 'have', 'has', 'do', 'does', 'did', 'can',
      'pending', 'completed', 'in_progress', 'inprogress', 'progress',
      'order', 'orders', 'dispatch', 'dispatches', 'invoice', 'invoices',
      'status', 'detail', 'details', 'summary', 'report', 'available',
      'the', 'a', 'an', 'and', 'or', 'of', 'for', 'by', 'in', 'on', 'at',
      'my', 'our', 'their', 'today', 'yesterday', 'week', 'month', 'year',
      'customer', 'customers', 'marketing', 'person', 'how', 'many',
      'which', 'where', 'when', 'who', 'why', 'please', 'tell', 'about',
    ]);

    const words = question.trim().split(/\s+/);

    for (const word of words) {
      const clean = word.replace(/[^a-zA-Z0-9]/g, '');
      // Skip short words and known non-customer words
      if (clean.length < 2 || skipWords.has(clean.toLowerCase())) {
        continue;
      }
      // Try this word against the database
      const customers = await this.lookupCustomerIds(clean);
      if (customers.length > 0) {
        return { keyword: clean, customers };
      }
    }
    return null;
  }

  // Generate SQL query using AI
  static async queryFromNaturalLanguage(userQuestion, apiConfig, marketingPersons = null) {
    try {
      // Handle both single string and array input
      let mpArray = [];
      if (marketingPersons) {
        mpArray = Array.isArray(marketingPersons) ? marketingPersons : [marketingPersons];
      }

      const hasFilter = mpArray.length > 0;
      const filterLog = hasFilter ? ` [Marketing Persons: ${mpArray.join(', ')}]` : '';
      console.log(`🤖 Processing natural language query: "${userQuestion}"${filterLog}`);

      // Get database schema
      const schema = await this.getDatabaseSchema();
      if (!schema) {
        throw new Error('Failed to get database schema');
      }

      // Build schema description for AI
      const schemaDescription = this.buildSchemaDescription(schema);

      // Pre-lookup customer IDs by checking each word against the database
      let customerIdFilter = '';
      const customerMatch = await this.findCustomerInQuestion(userQuestion);
      if (customerMatch) {
        const { keyword, customers } = customerMatch;
        const idList = customers.map(c => c.id).join(', ');
        const nameList = customers.map(c => c.customer_name).join(', ');
        customerIdFilter = `\n\nCUSTOMER FILTER (pre-resolved from database):
The question refers to customer keyword "${keyword}".
Matched customers in mastercustomer: ${nameList}
Their customer IDs are: ${idList}
You MUST filter orders using: o.customer_id IN (${idList})
Do NOT use LIKE on customer_name - use the customer_id IN filter instead.`;
        console.log(`✅ Pre-resolved customer keyword "${keyword}" -> IDs: ${idList} (${nameList})`);
      }

      // Build marketing person filter instruction
      let marketingPersonFilter = '';
      if (hasFilter) {
        if (mpArray.length === 1) {
          // Single marketing person - use = operator
          marketingPersonFilter = `\n\nCRITICAL SECURITY FILTER:
You MUST add this WHERE clause to ALL queries involving Database_orderregister:
WHERE marketing_person = '${mpArray[0].replace(/'/g, "''")}'

This user can ONLY see orders assigned to marketing person: ${mpArray[0]}
Always include this filter in your SQL queries. This is a security requirement.`;
        } else {
          // Multiple marketing persons - use IN operator
          const quotedList = mpArray.map(mp => `'${mp.replace(/'/g, "''")}'`).join(', ');
          marketingPersonFilter = `\n\nCRITICAL SECURITY FILTER:
You MUST add this WHERE clause to ALL queries involving Database_orderregister:
WHERE marketing_person IN (${quotedList})

This user can ONLY see orders assigned to these marketing persons: ${mpArray.join(', ')}
Always include this filter in your SQL queries. This is a security requirement.`;
        }
      }

      // Build AI prompt
      const systemPrompt = `You are a SQL expert for Thirupathybright Industries database.${marketingPersonFilter}${customerIdFilter}

DATABASE SCHEMA:
${schemaDescription}

IMPORTANT RULES:
1. ONLY generate SELECT queries (no INSERT, UPDATE, DELETE)
2. Always use fully qualified table names: thirupathybright.table_name
3. Use JOINs when data from multiple tables is needed
4. For order lookup: ALWAYS SELECT ALL FIELDS (o.*) from Database_orderregister and include customer name
5. For customer info: JOIN with mastercustomer to get customer_name
6. For dispatch tracking: Use subqueries or JOINs to calculate:
   - Total dispatched quantity: SUM of weightment_weight from Database_weightment
   - Remaining quantity: order quantity_kg - total dispatched
   - Number of dispatches completed
7. Field name mappings:
   - Database_despatch has 'despatchno' (no underscore) - NOTE: Capital 'D'
   - database_weightment has 'despatch_no' (with underscore)
   - Database_despatchinvoice has 'despatch_no' (with underscore) - NOTE: Capital 'D'
8. For order status queries, include:
   - ALL order fields (order_number, po_number, po_date, quantity_kg, rate, material, payment_terms, etc.)
   - Customer name from mastercustomer
   - Total dispatched weight
   - Remaining quantity to dispatch
   - Dispatch count
9. Use LIMIT to prevent large result sets (max 50 rows)
10. CUSTOMER NAME FILTERING: If a customer_id IN filter is provided above, use that. Otherwise if the
    question mentions a company name, use: c.customer_name LIKE '%KEYWORD%' (case-insensitive).
11. STATUS RULE - CRITICAL:
    - "pending" or "pending orders" means NOT completed and NOT cancelled.
      Use: o.status IN ('pending', 'in_progress')
    - "in progress" or "in_progress" means ONLY: o.status = 'in_progress'
    - "completed" means ONLY: o.status = 'completed'
    - Never use o.status = 'pending' alone when the user asks for pending orders.

EXAMPLE for pending customer orders (includes in_progress):
SELECT
  o.*,
  c.customer_name,
  COALESCE(SUM(w.weightment_weight), 0) as total_dispatched,
  (o.quantity_kg - COALESCE(SUM(w.weightment_weight), 0)) as remaining_qty,
  COUNT(DISTINCT d.despatchno) as dispatch_count
FROM thirupathybright.Database_orderregister o
LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
LEFT JOIN thirupathybright.Database_despatch d ON d.order_no_id = o.id
LEFT JOIN thirupathybright.Database_weightment w ON w.despatch_no = d.despatchno
WHERE o.status IN ('pending', 'in_progress')
  AND o.customer_id IN (1929)
GROUP BY o.id
LIMIT 50

RESPONSE FORMAT:
Return ONLY valid SQL query, nothing else. No explanations, no markdown, just SQL.`;

      const userPrompt = `Generate SQL query for: ${userQuestion}`;

      // Call Sarvam AI
      const response = await fetch(apiConfig.API_URL, {
        method: 'POST',
        headers: {
          'api-subscription-key': apiConfig.API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: apiConfig.MODEL,
          messages: [
            { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
          ]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      let sqlQuery = data.choices?.[0]?.message?.content?.trim();

      if (!sqlQuery) {
        throw new Error('No SQL query generated');
      }

      // Clean up the SQL query (remove markdown code blocks if present)
      sqlQuery = sqlQuery.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();

      console.log(`📝 Generated SQL:\n${sqlQuery}`);

      // Execute the query
      const result = await this.executeQuery(sqlQuery);

      return {
        success: result.success,
        query: sqlQuery,
        data: result.rows,
        count: result.count,
        error: result.error
      };

    } catch (error) {
      console.error('❌ Natural language query error:', error);
      return {
        success: false,
        error: error.message,
        data: [],
        count: 0
      };
    }
  }

  // Build schema description for AI
  static buildSchemaDescription(schema) {
    let description = '';

    for (const [tableName, tableInfo] of Object.entries(schema.tables)) {
      description += `\nTable: ${tableName}\n`;
      description += `Columns:\n`;

      tableInfo.columns.forEach(col => {
        description += `  - ${col.name} (${col.type})`;
        if (col.key === 'PRI') description += ' PRIMARY KEY';
        if (col.key === 'MUL') description += ' FOREIGN KEY';
        description += '\n';
      });
    }

    // Add relationship descriptions
    description += `\nTABLE RELATIONSHIPS:
- Database_orderregister.customer_id -> mastercustomer.id
- Database_orderregister.id -> Database_despatch.order_no_id
- Database_despatch.despatchno -> Database_weightment.despatch_no
- Database_despatch.despatchno -> Database_despatchinvoice.despatch_no

IMPORTANT: Use correct table name capitalization:
- Database_despatch (capital D)
- Database_despatchinvoice (capital D)
- Database_orderregister (lowercase d)
- Database_weightment (lowercase d)
- mastercustomer (lowercase m)

COMMON QUERIES:
- Order by number: SELECT from Database_orderregister WHERE order_number = ?
- Customer orders: JOIN Database_orderregister with mastercustomer
- Dispatch details: JOIN Database_despatch with Database_weightment and Database_despatchinvoice
- Order status: pending, in_progress, completed
`;

    return description;
  }

  /**
   * Format query result directly as plain text ready for the user.
   * Returns { directReply: string } so the caller can send it without
   * passing through the AI again, OR returns { context: string } for
   * single-record lookups where AI adds value.
   */
  static formatResultForAI(result) {
    if (!result.success) {
      return `Database error: ${result.error}. Please try a different question.`;
    }

    if (result.count === 0) {
      return 'No data found for your query.';
    }

    const data = result.data;

    // ── Single record: let AI present it with its conversational touch ──
    if (result.count === 1) {
      const r = data[0];
      let context = `\n\n[SYSTEM: Found 1 record.\nDATA:\n`;
      const essentialFields = [
        'order_number', 'status', 'customer_name', 'material_status',
        'po_number', 'po_date', 'expected_date', 'quantity_kg',
        'material', 'rate', 'payment_terms', 'delivery_address',
        'total_dispatched', 'remaining_qty', 'dispatch_count',
        'despatchno', 'weightment_weight', 'actual_time'
      ];
      for (const field of essentialFields) {
        if (r[field] !== undefined && r[field] !== null && r[field] !== '') {
          context += `  ${field}: ${r[field]}\n`;
        }
      }
      context += `Present this data as plain text, no markdown, no emojis.]`;
      return context;
    }

    // ── Multiple records: build plain-text reply directly, skip AI re-formatting ──
    const maxRecords = Math.min(50, result.count);
    const limited = data.slice(0, maxRecords);

    // Check if this looks like an order list (has order_number field)
    const isOrderList = limited[0] && limited[0].order_number !== undefined;

    if (isOrderList) {
      // Compute totals
      let totalOrderQty = 0;
      let totalDispatched = 0;
      let totalRemaining = 0;
      limited.forEach(r => {
        totalOrderQty  += parseFloat(r.quantity_kg   || 0);
        totalDispatched += parseFloat(r.total_dispatched || 0);
        totalRemaining  += parseFloat(r.remaining_qty   || 0);
      });

      let out = `Found ${result.count} order(s):\n`;
      out += '─'.repeat(30) + '\n';

      limited.forEach((r, i) => {
        out += `${i + 1}. ${r.order_number || 'N/A'}`;
        if (r.customer_name) out += ` | ${r.customer_name}`;
        out += '\n';

        if (r.material)       out += `   Material : ${r.material}\n`;
        if (r.quantity_kg != null) out += `   Ordered  : ${Number(r.quantity_kg).toLocaleString()} kg\n`;
        if (r.total_dispatched != null) out += `   Dispatched: ${Number(r.total_dispatched).toLocaleString()} kg\n`;
        if (r.remaining_qty != null)    out += `   Remaining : ${Number(r.remaining_qty).toLocaleString()} kg\n`;
        if (r.status)         out += `   Status   : ${r.status}\n`;
        if (r.material_status && r.status !== 'completed') out += `   Mat.Status: ${r.material_status}\n`;
        if (r.expected_date && r.status !== 'completed')   out += `   Expected  : ${r.expected_date}\n`;
        if (r.po_number)      out += `   PO Number : ${r.po_number}\n`;
        out += '\n';
      });

      if (result.count > maxRecords) {
        out += `(showing first ${maxRecords} of ${result.count} orders)\n\n`;
      }

      out += '─'.repeat(30) + '\n';
      out += `TOTALS:\n`;
      out += `  Total Ordered   : ${totalOrderQty.toLocaleString()} kg\n`;
      out += `  Total Dispatched: ${totalDispatched.toLocaleString()} kg\n`;
      out += `  Total Remaining : ${totalRemaining.toLocaleString()} kg\n`;

      // Return as DIRECT_REPLY so server.js sends it without AI reprocessing
      return `\n\n[DIRECT_REPLY:\n${out}]`;
    }

    // ── Fallback for non-order multi-record results ──
    let context = `\n\n[SYSTEM: Found ${result.count} record(s).\nDATA:\n`;
    const essentialFields = [
      'order_number', 'status', 'customer_name', 'material_status',
      'po_number', 'po_date', 'expected_date', 'quantity_kg',
      'material', 'rate', 'payment_terms', 'delivery_address',
      'total_dispatched', 'remaining_qty', 'dispatch_count',
      'despatchno', 'weightment_weight', 'actual_time'
    ];
    limited.forEach((record, index) => {
      context += `Record ${index + 1}:\n`;
      for (const field of essentialFields) {
        if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
          context += `  ${field}: ${record[field]}\n`;
        }
      }
      context += '\n';
    });
    if (result.count > maxRecords) {
      context += `... and ${result.count - maxRecords} more records (showing first ${maxRecords} only)\n`;
    }
    context += `Present this data as plain text, no markdown, no emojis.]`;
    return context;
  }

  // Close database pool
  static async close() {
    try {
      if (pool) {
        await pool.end();
        console.log('✅ SQL Agent pool closed');
      }
    } catch (error) {
      console.error('❌ Error closing SQL Agent pool:', error);
    }
  }
}

// Initialize on module load
SQLAgent.init();

module.exports = SQLAgent;
