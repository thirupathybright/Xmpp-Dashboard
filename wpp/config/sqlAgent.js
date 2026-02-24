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
        'Database_despatchinvoice',
        'Database_sku',
        'Database_stockregister',
        'Database_rejectedstock',
        'Database_quarantinestock',
        'Database_grade',
        'Database_condition',
        'Database_shape',
        'Database_size',
        'Database_production'
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
      // Safety check - only allow SELECT queries; block any write/DDL keywords
      const normalizedSQL = sql.trim().toUpperCase();
      if (!normalizedSQL.startsWith('SELECT')) {
        throw new Error('Only SELECT queries are allowed');
      }
      const forbiddenKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'REPLACE', 'MERGE', 'CALL', 'EXEC', 'GRANT', 'REVOKE'];
      for (const kw of forbiddenKeywords) {
        const re = new RegExp(`\\b${kw}\\b`);
        if (re.test(normalizedSQL)) {
          throw new Error(`Query contains forbidden keyword: ${kw}`);
        }
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
      'stock', 'sku', 'inventory', 'closing', 'opening', 'inward', 'outward',
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

      // ── Bar type / grand total stock fast-path ──
      const hasBlackBar  = /black\s*bar/i.test(userQuestion);
      const hasBrightBar = /bright\s*bar/i.test(userQuestion);
      const hasBoth      = hasBlackBar && hasBrightBar;
      // "total stock", "all stock", "grand total" without bar type = grand total
      const isGrandTotal = !hasBlackBar && !hasBrightBar &&
        /\b(total|grand|all)\b.*\bstock\b|\bstock\b.*\b(total|grand|all)\b/i.test(userQuestion);

      if (hasBlackBar || hasBrightBar || isGrandTotal) {
        const sumQty = rows => rows.reduce((acc, r) => acc + parseFloat(r.closing_qty || 0), 0);

        // Helper: fetch totals for one bar flag across all 3 tables
        const fetchBarTotals = async (barFlag) => {
          const [regRes, rejRes, quarRes] = await Promise.all([
            this.executeQuery(
              `SELECT COALESCE(s.closing_qty, 0) AS closing_qty FROM thirupathybright.Database_stockregister s LEFT JOIN thirupathybright.Database_sku sk ON s.sku_id = sk.id WHERE sk.is_blackbar = ?`,
              [barFlag]
            ),
            this.executeQuery(
              `SELECT COALESCE(r.closing_qty, 0) AS closing_qty FROM thirupathybright.Database_rejectedstock r LEFT JOIN thirupathybright.Database_sku sk ON r.sku_id = sk.id WHERE sk.is_blackbar = ?`,
              [barFlag]
            ),
            this.executeQuery(
              `SELECT COALESCE(q.closing_qty, 0) AS closing_qty FROM thirupathybright.Database_quarantinestock q LEFT JOIN thirupathybright.Database_sku sk ON q.sku_id = sk.id WHERE sk.is_blackbar = ?`,
              [barFlag]
            )
          ]);
          return {
            reg:  sumQty(regRes.rows),
            rej:  sumQty(rejRes.rows),
            quar: sumQty(quarRes.rows)
          };
        };

        let out = '';

        if (isGrandTotal || hasBoth) {
          // Fetch both bar types in parallel
          console.log(`⚡ Grand total (Black Bar + Bright Bar) stock fast-path`);
          const [black, bright] = await Promise.all([fetchBarTotals(1), fetchBarTotals(0)]);

          const blackTotal  = black.reg  + black.rej  + black.quar;
          const brightTotal = bright.reg + bright.rej + bright.quar;
          const grandTotal  = blackTotal + brightTotal;

          out  = `Total Stock Summary:\n`;
          out += '─'.repeat(30) + '\n\n';
          out += `Black Bar:\n`;
          out += `  Regular Stock    : ${black.reg.toLocaleString()}\n`;
          out += `  Rejected Stock   : ${black.rej.toLocaleString()}\n`;
          out += `  Quarantine Stock : ${black.quar.toLocaleString()}\n`;
          out += `  Sub-Total        : ${blackTotal.toLocaleString()}\n\n`;
          out += `Bright Bar:\n`;
          out += `  Regular Stock    : ${bright.reg.toLocaleString()}\n`;
          out += `  Rejected Stock   : ${bright.rej.toLocaleString()}\n`;
          out += `  Quarantine Stock : ${bright.quar.toLocaleString()}\n`;
          out += `  Sub-Total        : ${brightTotal.toLocaleString()}\n\n`;
          out += '─'.repeat(30) + '\n';
          out += `Grand Total        : ${grandTotal.toLocaleString()}\n`;

        } else {
          // Single bar type
          const barFlag = hasBlackBar ? 1 : 0;
          const barLabel = hasBlackBar ? 'Black Bar' : 'Bright Bar';
          console.log(`⚡ ${barLabel} total stock fast-path`);
          const t = await fetchBarTotals(barFlag);
          const total = t.reg + t.rej + t.quar;

          out  = `${barLabel} Stock Summary:\n`;
          out += '─'.repeat(30) + '\n\n';
          out += `Regular Stock    : ${t.reg.toLocaleString()}\n`;
          out += `Rejected Stock   : ${t.rej.toLocaleString()}\n`;
          out += `Quarantine Stock : ${t.quar.toLocaleString()}\n`;
          out += '─'.repeat(30) + '\n';
          out += `Total Stock      : ${total.toLocaleString()}\n`;
        }

        return {
          success: true,
          query: 'bartype-stock',
          data: [],
          count: 0,
          error: null,
          _directReply: out
        };
      }

      // ── PP number fast-path (e.g. "Pp-2602-1595 production plan data") ──
      // Matches PP-YYYY-NNNN or PP YYYY NNNN patterns and queries production by ppno.
      const ppnoMatch = userQuestion.match(/\b(PP[-\s]\d{4}[-\s]\d+)\b/i);
      if (ppnoMatch) {
        // Normalise to "PP-2602-1595" form
        const ppno = ppnoMatch[1].replace(/\s/g, '-').toUpperCase();
        // Also build a LIKE pattern using just the numeric portion (handles any prefix casing/spacing)
        const ppnoLike = `%${ppno.replace(/^PP[-\s]/i, '')}%`;
        console.log(`⚡ PP number fast-path for ppno: "${ppno}"`);

        const ppSQL = `
SELECT
  p.*,
  c.customer_name,
  CONCAT(g.name, ' - ', cond.name, ' - ', sh.name, ' - ', sz.name) AS sku
FROM thirupathybright.Database_production p
LEFT JOIN thirupathybright.mastercustomer c ON p.customer_id = c.id
LEFT JOIN thirupathybright.Database_grade g ON p.grade_id = g.id
LEFT JOIN thirupathybright.Database_condition cond ON p.condition_id = cond.id
LEFT JOIN thirupathybright.Database_shape sh ON p.shape_id = sh.id
LEFT JOIN thirupathybright.Database_size sz ON p.finish_metal_size_id = sz.id
WHERE UPPER(p.ppno) = ? OR UPPER(p.ppno) LIKE ? OR UPPER(p.ppnoreference) = ? OR UPPER(p.ppnoreference) LIKE ?`.trim();

        const ppResult = await this.executeQuery(ppSQL, [ppno, ppnoLike, ppno, ppnoLike]);

        // If not found, return a clear direct reply instead of falling through to AI
        if (!ppResult.success || ppResult.count === 0) {
          return {
            success: true,
            query: ppSQL,
            data: [],
            count: 0,
            error: null,
            _directReply: `Production plan ${ppno} not found.\nPlease check the PP number and try again.`
          };
        }

        return {
          success: ppResult.success,
          query: ppSQL,
          data: ppResult.rows,
          count: ppResult.count,
          error: ppResult.error,
          _isProductionQuery: true,
          _statusContext: userQuestion,
          _ppLookup: true   // exact PP lookup — show real status, not "Not Approved" bucket
        };
      }

      // ── Production query fast-path ──
      // Triggers when the question is about production (plan/pending/in_progress/completed/customer/sku)
      // Must run BEFORE stock fast-path so "Pp-XXXX production pending" doesn't get grabbed as a SKU.
      const isProductionQuery = /\bproduction\b/i.test(userQuestion);

      if (isProductionQuery) {
        console.log(`⚡ Production fast-path triggered`);

        // Determine which statuses the user wants
        const wantsCompleted  = /\bcompleted?\b/i.test(userQuestion);
        const wantsCancelled  = /\bcancel(?:led)?\b/i.test(userQuestion);
        let statusClause;
        if (wantsCompleted)       statusClause = `p.status = 'completed'`;
        else if (wantsCancelled)  statusClause = `p.status = 'cancelled'`;
        else                      statusClause = `p.status IN ('pending', 'in_progress')`;

        // Build customer filter if pre-resolved
        let prodCustomerClause = '';
        const prodCustomerMatch = await this.findCustomerInQuestion(userQuestion);
        if (prodCustomerMatch) {
          const idList = prodCustomerMatch.customers.map(c => c.id).join(', ');
          prodCustomerClause = ` AND p.customer_id IN (${idList})`;
          console.log(`✅ Production customer filter: IDs ${idList}`);
        }

        const prodSQL = `
SELECT
  p.*,
  c.customer_name,
  CONCAT(g.name, ' - ', cond.name, ' - ', sh.name, ' - ', sz.name) AS sku
FROM thirupathybright.Database_production p
LEFT JOIN thirupathybright.mastercustomer c ON p.customer_id = c.id
LEFT JOIN thirupathybright.Database_grade g ON p.grade_id = g.id
LEFT JOIN thirupathybright.Database_condition cond ON p.condition_id = cond.id
LEFT JOIN thirupathybright.Database_shape sh ON p.shape_id = sh.id
LEFT JOIN thirupathybright.Database_size sz ON p.finish_metal_size_id = sz.id
WHERE ${statusClause}${prodCustomerClause}
ORDER BY p.created_at DESC`.trim();

        const prodResult = await this.executeQuery(prodSQL);

        return {
          success: prodResult.success,
          query: prodSQL,
          data: prodResult.rows,
          count: prodResult.count,
          error: prodResult.error,
          _isProductionQuery: true,
          _statusContext: userQuestion
        };
      }

      // ── Stock query fast-path ──
      // Strip "stock" from start or end, then check if the remainder is a SKU-like code.
      // A SKU looks like: EN1A-Black-COIL-10  (letters/digits separated by dashes, no common words).
      // Natural language sentences like "What is the stock" must NOT trigger this path.
      const naturalLanguageWords = new Set([
        'what', 'whats', 'how', 'show', 'list', 'give', 'get', 'find', 'fetch',
        'tell', 'is', 'are', 'the', 'a', 'an', 'of', 'for', 'in', 'all', 'me',
        'check', 'any', 'current', 'available', 'total', 'remaining',
        // order-related words — prevent order queries from hitting stock fast-path
        'order', 'orders', 'pending', 'completed', 'progress', 'inprogress',
        'dispatch', 'dispatches', 'invoice', 'invoices', 'status', 'customer',
        // production-related words — prevent production queries from hitting stock fast-path
        'production', 'plan', 'data', 'number', 'pp',
        // company name words — "Poly Hose India Pvt Ltd" should NOT be a SKU
        'pvt', 'ltd', 'private', 'limited', 'india', 'industries', 'company',
        'corp', 'corporation', 'enterprises', 'solutions', 'services', 'group',
        'hose', 'pipe', 'steel', 'metals', 'forging', 'casting', 'engineering',
      ]);
      const stripped = userQuestion.trim().replace(/^stock\s+/i, '').replace(/\s+stock$/i, '').trim();
      const hadStockWord = stripped.length < userQuestion.trim().length;
      // Only treat as SKU fast-path if stripped text has no natural-language words
      const strippedWords = stripped.toLowerCase().split(/\s+/);
      const hasNaturalWords = strippedWords.some(w => naturalLanguageWords.has(w));
      const looksLikeSku = !hasNaturalWords && /^[a-zA-Z0-9]+([-\s][a-zA-Z0-9.]+){1,8}$/.test(stripped);

      if ((hadStockWord && !hasNaturalWords) || looksLikeSku) {
        const skuKeyword = stripped;
        console.log(`⚡ Stock fast-path for SKU keyword: "${skuKeyword}"`);

        // Query all three stock tables in parallel
        const likeParam = [`%${skuKeyword}%`];
        const [regRes, rejRes, quarRes] = await Promise.all([
          this.executeQuery(
            `SELECT s.*, sk.skuname FROM thirupathybright.Database_stockregister s LEFT JOIN thirupathybright.Database_sku sk ON s.sku_id = sk.id WHERE LOWER(sk.skuname) LIKE LOWER(?)`,
            likeParam
          ),
          this.executeQuery(
            `SELECT r.*, sk.skuname FROM thirupathybright.Database_rejectedstock r LEFT JOIN thirupathybright.Database_sku sk ON r.sku_id = sk.id WHERE LOWER(sk.skuname) LIKE LOWER(?)`,
            likeParam
          ),
          this.executeQuery(
            `SELECT q.*, sk.skuname FROM thirupathybright.Database_quarantinestock q LEFT JOIN thirupathybright.Database_sku sk ON q.sku_id = sk.id WHERE LOWER(sk.skuname) LIKE LOWER(?)`,
            likeParam
          )
        ]);

        // Tag each row with its source so the formatter can separate them
        const tag = (rows, source) => rows.map(r => ({ ...r, _stockSource: source }));
        const combined = [
          ...tag(regRes.rows,  'regular'),
          ...tag(rejRes.rows,  'rejected'),
          ...tag(quarRes.rows, 'quarantine')
        ];

        return {
          success: true,
          query: 'combined-stock',
          data: combined,
          count: combined.length,
          error: null,
          _isStockQuery: true
        };
      }

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
4. For order lookup: ALWAYS SELECT ALL FIELDS (o.*) from Database_orderregister and include customer name and SKU
5. For customer info: JOIN with mastercustomer to get customer_name
5a. For SKU: ALWAYS JOIN Database_grade, Database_condition, Database_shape, Database_size and build:
    CONCAT(g.name, ' - ', cond.name, ' - ', sh.name, ' - ', sz.name) AS sku
6. For dispatch tracking: Use subqueries or JOINs to calculate:
   - Total dispatched quantity: SUM of weightment_weight from Database_weightment
   - Remaining quantity: order quantity_kg - total dispatched
   - Number of dispatches completed
7. Field name mappings:
   - Database_despatch has 'despatchno' (no underscore) - NOTE: Capital 'D'
   - Database_weightment has 'despatch_no' (with underscore)
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
11. STOCK QUERIES - when the user asks about stock, inventory, closing stock, or SKU:
    - For SKU list: SELECT * FROM thirupathybright.Database_sku
    - For regular stock: JOIN Database_stockregister with Database_sku on sku_id
    - For rejected stock: JOIN Database_rejectedstock with Database_sku on sku_id
    - For quarantine stock: JOIN Database_quarantinestock with Database_sku on sku_id
    - When filtering by SKU name/code, always use LIKE (case-insensitive): LOWER(sk.skuname) LIKE LOWER('%keyword%')
    - The closing quantity column may be named closing_qty or closing_stock — use whichever exists per the schema above
    - Do NOT apply marketing_person filter to stock/SKU tables (they are not order tables)
    - Do NOT apply customer_id filter to stock/SKU tables (they are not order tables)
12. STATUS RULE - CRITICAL:
    - "pending" or "pending orders" means NOT completed and NOT cancelled.
      Use: o.status IN ('pending', 'in_progress')
    - "in progress" or "in_progress" means ONLY: o.status = 'in_progress'
    - "completed" means ONLY: o.status = 'completed'
    - Never use o.status = 'pending' alone when the user asks for pending orders.

EXAMPLE for pending customer orders (includes in_progress):
SELECT
  o.*,
  c.customer_name,
  CONCAT(g.name, ' - ', cond.name, ' - ', sh.name, ' - ', sz.name) AS sku,
  COALESCE(SUM(w.weightment_weight), 0) as total_dispatched,
  (o.quantity_kg - COALESCE(SUM(w.weightment_weight), 0)) as remaining_qty,
  COUNT(DISTINCT d.despatchno) as dispatch_count
FROM thirupathybright.Database_orderregister o
LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
LEFT JOIN thirupathybright.Database_grade g ON o.grade_id = g.id
LEFT JOIN thirupathybright.Database_condition cond ON o.condition_id = cond.id
LEFT JOIN thirupathybright.Database_shape sh ON o.shape_id = sh.id
LEFT JOIN thirupathybright.Database_size sz ON o.size_id = sz.id
LEFT JOIN thirupathybright.Database_despatch d ON d.order_no_id = o.id
LEFT JOIN thirupathybright.Database_weightment w ON w.despatch_no = d.despatchno
WHERE o.status IN ('pending', 'in_progress')
  AND o.customer_id IN (1929)
GROUP BY o.id

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

      // Strip any LIMIT clause the AI added — we always fetch all rows
      sqlQuery = sqlQuery.replace(/\bLIMIT\s+\d+\b/gi, '').trim().replace(/;\s*$/, '');

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
- Database_orderregister.grade_id -> Database_grade.id
- Database_orderregister.condition_id -> Database_condition.id
- Database_orderregister.shape_id -> Database_shape.id
- Database_orderregister.size_id -> Database_size.id
- Database_orderregister.id -> Database_despatch.order_no_id
- Database_despatch.despatchno -> Database_weightment.despatch_no
- Database_despatch.despatchno -> Database_despatchinvoice.despatch_no
- Database_stockregister.sku_id -> Database_sku.id
- Database_rejectedstock.sku_id -> Database_sku.id
- Database_quarantinestock.sku_id -> Database_sku.id
- Database_production.customer_id -> mastercustomer.id
- Database_production.grade_id -> Database_grade.id
- Database_production.condition_id -> Database_condition.id
- Database_production.shape_id -> Database_shape.id
- Database_production.finish_metal_size_id -> Database_size.id

SKU FORMAT: The SKU for an order or production record is built as:
  CONCAT(g.name, ' - ', cond.name, ' - ', sh.name, ' - ', sz.name)
where g = Database_grade, cond = Database_condition, sh = Database_shape, sz = Database_size

PRODUCTION STATUS LABELS:
- status = 'pending'     -> display as "Production Not Approved"
- status = 'in_progress' -> display as "Production Not Approved"
- status = 'completed'   -> display as "Completed"
- status = 'cancelled'   -> display as "Cancelled"
By default (when user asks for production pending), show status IN ('pending','in_progress') — both shown as "Production Not Approved".
Only show completed or cancelled when the user explicitly asks for them.

IMPORTANT: Use correct table name capitalization:
- Database_despatch (capital D)
- Database_despatchinvoice (capital D)
- Database_orderregister (capital D)
- Database_weightment (capital D)
- mastercustomer (lowercase m)
- Database_sku (capital D)
- Database_stockregister (capital D)
- Database_rejectedstock (capital D)
- Database_quarantinestock (capital D)
- Database_grade (capital D)
- Database_condition (capital D)
- Database_shape (capital D)
- Database_size (capital D)
- Database_production (capital D)

COMMON QUERIES:
- Order by number: SELECT from Database_orderregister WHERE order_number = ?
- Customer orders: JOIN Database_orderregister with mastercustomer
- Dispatch details: JOIN Database_despatch with Database_weightment and Database_despatchinvoice
- Order status: pending, in_progress, completed
- SKU list: SELECT from thirupathybright.Database_sku
- Regular stock: JOIN Database_stockregister with Database_sku on sku_id (closing_qty or closing_stock column)
- Rejected stock: JOIN Database_rejectedstock with Database_sku on sku_id
- Quarantine stock: JOIN Database_quarantinestock with Database_sku on sku_id
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

    // ── Stock register (closing stock) results — checked FIRST before single-record branch ──
    // Helper: pick first defined non-null value from a list of column name variants
    const pick = (r, ...keys) => {
      for (const k of keys) {
        if (r[k] !== undefined && r[k] !== null) return r[k];
      }
      return null;
    };

    const closingQtyKeys = ['closing_qty'];
    const isStockResult = result._isStockQuery || (data[0] && closingQtyKeys.some(k => data[0][k] !== undefined));

    if (isStockResult) {
      // Separate rows by source (tagged by fast-path) or treat all as regular
      const regular    = data.filter(r => !r._stockSource || r._stockSource === 'regular');
      const rejected   = data.filter(r => r._stockSource === 'rejected');
      const quarantine = data.filter(r => r._stockSource === 'quarantine');

      const formatSection = (rows, label) => {
        if (rows.length === 0) return '';
        let sec = `${label}:\n`;
        rows.forEach((r, i) => {
          const skuLabel = r.skuname || r.sku_code || r.sku_name || r.name || r.sku_id || r.id || `Item ${i + 1}`;
          sec += `  ${i + 1}. ${skuLabel}\n`;
          if (r.unit)        sec += `     Unit        : ${r.unit}\n`;
          const closingVal = pick(r, ...closingQtyKeys);
          if (closingVal != null) sec += `     Closing Qty : ${Number(closingVal).toLocaleString()}\n`;
          if (r.date)        sec += `     Date        : ${r.date}\n`;
          sec += '\n';
        });
        return sec;
      };

      const hasAny = regular.length > 0 || rejected.length > 0 || quarantine.length > 0;
      if (!hasAny) return 'No data found for your query.';

      // Use first row for SKU name in header
      const firstRow = data[0];
      const skuHeader = firstRow.skuname || firstRow.sku_code || firstRow.sku_name || firstRow.name || '';
      let out = skuHeader ? `Stock for: ${skuHeader}\n` : `Stock Summary:\n`;
      out += '─'.repeat(30) + '\n\n';

      out += formatSection(regular,    'Regular Stock');
      out += formatSection(rejected,   'Rejected Stock');
      out += formatSection(quarantine, 'Quarantine Stock');

      if (regular.length === 0 && (rejected.length > 0 || quarantine.length > 0)) {
        out += `Regular Stock : No data\n\n`;
      }

      return `\n\n[DIRECT_REPLY:\n${out}]`;
    }

    // ── Production results ──
    const isProductionResult = result._isProductionQuery || (data[0] && data[0].ppno !== undefined);

    if (isProductionResult) {
      const wantsCompletedFmt  = /\bcompleted?\b/i.test(result._statusContext || '');
      const wantsCancelledFmt  = /\bcancel(?:led)?\b/i.test(result._statusContext || '');
      // For exact PP lookups, always show real status labels (not the "pending bucket" label)
      const showingPending     = !result._ppLookup && !wantsCompletedFmt && !wantsCancelledFmt;

      const statusLabel = s => {
        if (s === 'completed')   return 'Completed';
        if (s === 'cancelled')   return 'Cancelled';
        if (s === 'in_progress') return showingPending ? 'Production Not Approved' : 'In Progress';
        if (s === 'pending')     return 'Production Not Approved';
        return s || 'Unknown';
      };

      let totalQty = 0;
      data.forEach(r => { totalQty += parseFloat(r.quantity_kg || 0); });

      let out = `Found ${result.count} production record(s):\n`;
      out += '─'.repeat(30) + '\n';

      data.forEach((r, i) => {
        out += `${i + 1}. ${r.ppno || r.id || 'N/A'}`;
        if (r.customer_name) out += ` | ${r.customer_name}`;
        out += '\n';

        if (r.sku)              out += `   SKU         : ${r.sku}\n`;
        if (r.quantity_kg != null) out += `   Qty (kg)    : ${Number(r.quantity_kg).toLocaleString()}\n`;
        if (r.status)           out += `   Status      : ${statusLabel(r.status)}\n`;
        if (r.expected_date)    out += `   Expected    : ${r.expected_date}\n`;
        if (r.ppnoreference)    out += `   PP Ref      : ${r.ppnoreference}\n`;
        if (r.length)           out += `   Length      : ${r.length}\n`;
        if (r.notes)            out += `   Notes       : ${r.notes}\n`;
        out += '\n';
      });

      out += '─'.repeat(30) + '\n';
      out += `Total Qty : ${totalQty.toLocaleString()} kg\n`;

      return `\n\n[DIRECT_REPLY:\n${out}]`;
    }

    // ── Single record: let AI present it with its conversational touch ──
    if (result.count === 1) {
      const r = data[0];
      let context = `\n\n[SYSTEM: Found 1 record.\nDATA:\n`;
      const essentialFields = [
        'order_number', 'status', 'customer_name', 'sku', 'material_status',
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
    const limited = data;

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

        if (r.sku)            out += `   SKU      : ${r.sku}\n`;
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

      out += '─'.repeat(30) + '\n';
      out += `TOTALS:\n`;
      out += `  Total Ordered   : ${totalOrderQty.toLocaleString()} kg\n`;
      out += `  Total Dispatched: ${totalDispatched.toLocaleString()} kg\n`;
      out += `  Total Remaining : ${totalRemaining.toLocaleString()} kg\n`;

      // Return as DIRECT_REPLY so server.js sends it without AI reprocessing
      return `\n\n[DIRECT_REPLY:\n${out}]`;
    }

    // ── SKU list results (no closing qty column — pure SKU master data) ──
    const isSkuList = limited[0] && (limited[0].sku_code !== undefined || limited[0].sku_name !== undefined || limited[0].skuname !== undefined) && !closingQtyKeys.some(k => limited[0][k] !== undefined);

    if (isSkuList) {
      let out = `SKU List (${result.count} item(s)):\n`;
      out += '─'.repeat(30) + '\n';

      limited.forEach((r, i) => {
        const skuLabel = r.skuname || r.sku_code || r.sku_name || r.name || r.id || `SKU ${i + 1}`;
        out += `${i + 1}. ${skuLabel}\n`;
        if (r.description) out += `   Description : ${r.description}\n`;
        if (r.unit)        out += `   Unit        : ${r.unit}\n`;
        if (r.category)    out += `   Category    : ${r.category}\n`;
        out += '\n';
      });

      return `\n\n[DIRECT_REPLY:\n${out}]`;
    }

    // ── Fallback for non-order multi-record results ──
    let context = `\n\n[SYSTEM: Found ${result.count} record(s).\nDATA:\n`;
    const essentialFields = [
      'order_number', 'status', 'customer_name', 'sku', 'material_status',
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
