// Database Helper for Order Register Queries
const mysql = require('mysql2/promise');
const DATABASES = require('./sqlAuthenticator');

// Create connection pool
let pool = null;

class DatabaseHelper {
  // Initialize database connection pool
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
      console.log('✅ Database pool initialized');
    } catch (error) {
      console.error('❌ Database pool initialization failed:', error);
    }
  }

  // Test database connection
  static async testConnection() {
    try {
      const connection = await pool.getConnection();
      console.log('✅ Database connection successful');
      connection.release();
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      return false;
    }
  }

  // Get dispatch details for an order
  static async getDispatchDetails(orderId) {
    try {
      if (!orderId) {
        console.log('⚠️ No order ID provided for dispatch lookup');
        return { dispatches: [], totalDispatched: 0 };
      }

      // Get all dispatches for this order
      const dispatchQuery = `
        SELECT * FROM thirupathybright.database_despatch
        WHERE order_no_id = ?
      `;
      const [dispatches] = await pool.execute(dispatchQuery, [orderId]);

      console.log(`📦 Found ${dispatches.length} dispatches for order ID ${orderId}`);

      if (dispatches.length > 0) {
        console.log('📦 First dispatch fields:', Object.keys(dispatches[0]));
      }

      const dispatchDetails = [];
      let totalDispatched = 0;

      for (const dispatch of dispatches) {
        // Try multiple possible field names for dispatch number
        const despatchNo = dispatch.despatchno || dispatch.despatch_number || dispatch.despatch_no || dispatch.dispatch_number || dispatch.id;

        if (!despatchNo) {
          console.log('⚠️ Dispatch number field not found, skipping:', dispatch);
          continue;
        }

        console.log(`🔍 Processing dispatch: ${despatchNo}`);

        // Get weightment for this dispatch
        const weightQuery = `
          SELECT weightment_weight FROM thirupathybright.database_weightment
          WHERE despatch_no = ?
        `;
        const [weights] = await pool.execute(weightQuery, [despatchNo]);

        // Get invoice completion date for this dispatch
        const invoiceQuery = `
          SELECT actual_time FROM thirupathybright.database_despatchinvoice
          WHERE despatch_no = ? AND status = 'completed'
        `;
        const [invoices] = await pool.execute(invoiceQuery, [despatchNo]);

        const dispatchWeight = weights.length > 0 ? parseFloat(weights[0].weightment_weight || 0) : 0;
        const completionDate = invoices.length > 0 ? invoices[0].actual_time : null;

        console.log(`  - Weight: ${dispatchWeight} kg, Completed: ${completionDate ? 'Yes' : 'No'}`);

        totalDispatched += dispatchWeight;

        dispatchDetails.push({
          despatchNumber: despatchNo,
          weight: dispatchWeight,
          completionDate: completionDate,
          completed: invoices.length > 0
        });
      }

      console.log(`📦 Total dispatched: ${totalDispatched} kg`);

      return {
        dispatches: dispatchDetails,
        totalDispatched: totalDispatched
      };

    } catch (error) {
      console.error('❌ Error fetching dispatch details:', error);
      console.error('Stack:', error.stack);
      return {
        dispatches: [],
        totalDispatched: 0
      };
    }
  }

  // Get order status by order number with dispatch information
  static async getOrderStatus(orderNumber) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      console.log(`🔍 Searching for order: ${orderNumber}`);

      // Query with JOIN to get customer name
      const query = `
        SELECT
          o.*,
          c.customer_name
        FROM thirupathybright.database_orderregister o
        LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
        WHERE o.order_number = ?
        LIMIT 1
      `;
      const [rows] = await pool.execute(query, [orderNumber]);

      console.log(`📊 Query result: Found ${rows.length} rows`);

      if (rows.length === 0) {
        // Try case-insensitive search as fallback
        const queryCI = `
          SELECT
            o.*,
            c.customer_name
          FROM thirupathybright.database_orderregister o
          LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
          WHERE UPPER(o.order_number) = UPPER(?)
          LIMIT 1
        `;
        const [rowsCI] = await pool.execute(queryCI, [orderNumber]);

        console.log(`📊 Case-insensitive search: Found ${rowsCI.length} rows`);

        if (rowsCI.length === 0) {
          return {
            found: false,
            message: `Order number ${orderNumber} not found in our system.`
          };
        }

        const order = rowsCI[0];
        const dispatchInfo = await this.getDispatchDetails(order.id);

        console.log(`✅ Order found (case-insensitive):`, order);
        return this.formatOrderResponse(order, dispatchInfo);
      }

      const order = rows[0];
      const dispatchInfo = await this.getDispatchDetails(order.id);

      console.log(`✅ Order found: ${order.order_number} - Customer: ${order.customer_name}, Status: ${order.status}`);
      return this.formatOrderResponse(order, dispatchInfo);

    } catch (error) {
      console.error('❌ Database query error:', error);
      return {
        found: false,
        error: true,
        message: 'Sorry, I encountered an error while checking the order status. Please try again later.'
      };
    }
  }

  // Format order response based on status
  static formatOrderResponse(order, dispatchInfo) {
    const orderQty = parseFloat(order.quantity_kg || 0);
    const totalDispatched = dispatchInfo.totalDispatched;
    const remainingQty = orderQty - totalDispatched;

    const response = {
      found: true,
      orderNumber: order.order_number,
      customerName: order.customer_name,
      orderStatus: order.status,
      orderQty: orderQty,
      data: order
    };

    // PENDING: Not yet approved
    if (order.status === 'pending') {
      response.message = 'Order is pending approval';
      response.showMaterialStatus = false;
      response.showExpectedDate = false;
      response.showDispatch = false;
      return response;
    }

    // IN_PROGRESS: Show material status, expected date, and dispatch info
    if (order.status === 'in_progress') {
      response.materialStatus = order.material_status || 'Not yet updated';
      response.expectedDate = order.expected_date;
      response.showMaterialStatus = true;
      response.showExpectedDate = true;
      response.showDispatch = true;
      response.dispatchInfo = dispatchInfo.dispatches;
      response.totalDispatched = totalDispatched;
      response.remainingQty = remainingQty;
      return response;
    }

    // COMPLETED: Show dispatch info only, no material status or expected date
    if (order.status === 'completed') {
      response.showMaterialStatus = false;
      response.showExpectedDate = false;
      response.showDispatch = true;
      response.dispatchInfo = dispatchInfo.dispatches;
      response.totalDispatched = totalDispatched;
      response.remainingQty = remainingQty;
      response.isFullyDispatched = remainingQty <= 0;
      return response;
    }

    // Default for other statuses
    response.materialStatus = order.material_status;
    response.showMaterialStatus = true;
    response.showExpectedDate = true;
    response.expectedDate = order.expected_date;
    return response;
  }

  // Search for order number in the database (flexible search)
  static async searchOrders(searchTerm) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      const query = `SELECT * FROM thirupathybright.database_orderregister WHERE order_number LIKE ? LIMIT 10`;
      const [rows] = await pool.execute(query, [`%${searchTerm}%`]);

      return {
        found: rows.length > 0,
        count: rows.length,
        orders: rows
      };

    } catch (error) {
      console.error('❌ Database search error:', error);
      return {
        found: false,
        error: true,
        message: 'Sorry, I encountered an error while searching for orders.'
      };
    }
  }

  // Search customer by name
  static async searchCustomerByName(customerName) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      const query = `
        SELECT id, customer_name
        FROM thirupathybright.mastercustomer
        WHERE customer_name LIKE ?
        LIMIT 10
      `;
      const [customers] = await pool.execute(query, [`%${customerName}%`]);

      console.log(`🔍 Found ${customers.length} customers matching "${customerName}"`);

      return {
        found: customers.length > 0,
        count: customers.length,
        customers: customers
      };

    } catch (error) {
      console.error('❌ Customer search error:', error);
      return {
        found: false,
        error: true,
        message: 'Error searching for customer.'
      };
    }
  }

  // Get orders by customer ID and status
  static async getOrdersByCustomer(customerId, status = null) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      let query, params;

      if (status === 'pending') {
        // Pending and in_progress orders
        query = `
          SELECT o.*, c.customer_name
          FROM thirupathybright.database_orderregister o
          LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
          WHERE o.customer_id = ? AND o.status IN ('pending', 'in_progress')
          ORDER BY o.created_at DESC
        `;
        params = [customerId];
      } else if (status === 'completed') {
        // Completed orders only
        query = `
          SELECT o.*, c.customer_name
          FROM thirupathybright.database_orderregister o
          LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
          WHERE o.customer_id = ? AND o.status = 'completed'
          ORDER BY o.created_at DESC
        `;
        params = [customerId];
      } else {
        // All orders
        query = `
          SELECT o.*, c.customer_name
          FROM thirupathybright.database_orderregister o
          LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
          WHERE o.customer_id = ?
          ORDER BY o.created_at DESC
        `;
        params = [customerId];
      }

      const [orders] = await pool.execute(query, params);

      console.log(`📋 Found ${orders.length} orders for customer ID ${customerId} (status: ${status || 'all'})`);

      // Get dispatch info for each order
      const ordersWithDispatch = [];
      for (const order of orders) {
        const dispatchInfo = await this.getDispatchDetails(order.id);
        ordersWithDispatch.push({
          ...order,
          dispatchInfo: dispatchInfo
        });
      }

      return {
        found: orders.length > 0,
        count: orders.length,
        orders: ordersWithDispatch
      };

    } catch (error) {
      console.error('❌ Error getting customer orders:', error);
      return {
        found: false,
        error: true,
        message: 'Error retrieving customer orders.'
      };
    }
  }

  // Search dispatch by dispatch number
  static async getDispatchByNumber(dispatchNumber) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      const query = `
        SELECT
          d.*,
          o.order_number,
          o.customer_id,
          c.customer_name
        FROM thirupathybright.database_despatch d
        LEFT JOIN thirupathybright.database_orderregister o ON d.order_no_id = o.id
        LEFT JOIN thirupathybright.mastercustomer c ON o.customer_id = c.id
        WHERE d.despatchno LIKE ?
        LIMIT 10
      `;
      const [dispatches] = await pool.execute(query, [`%${dispatchNumber}%`]);

      console.log(`📦 Found ${dispatches.length} dispatches matching "${dispatchNumber}"`);

      if (dispatches.length === 0) {
        return {
          found: false,
          message: 'Dispatch not found.'
        };
      }

      // Get weight and invoice info for each dispatch
      const dispatchesWithDetails = [];
      for (const dispatch of dispatches) {
        const despatchNo = dispatch.despatchno;

        // Get weightment
        const weightQuery = `
          SELECT weightment_weight FROM thirupathybright.database_weightment
          WHERE despatch_no = ?
        `;
        const [weights] = await pool.execute(weightQuery, [despatchNo]);

        // Get invoice
        const invoiceQuery = `
          SELECT actual_time, status FROM thirupathybright.database_despatchinvoice
          WHERE despatch_no = ?
        `;
        const [invoices] = await pool.execute(invoiceQuery, [despatchNo]);

        dispatchesWithDetails.push({
          dispatchNumber: despatchNo,
          orderNumber: dispatch.order_number,
          customerName: dispatch.customer_name,
          weight: weights.length > 0 ? parseFloat(weights[0].weightment_weight || 0) : 0,
          completionDate: invoices.length > 0 ? invoices[0].actual_time : null,
          invoiceStatus: invoices.length > 0 ? invoices[0].status : 'Not invoiced'
        });
      }

      return {
        found: true,
        count: dispatches.length,
        dispatches: dispatchesWithDetails
      };

    } catch (error) {
      console.error('❌ Error searching dispatch:', error);
      return {
        found: false,
        error: true,
        message: 'Error searching for dispatch.'
      };
    }
  }

  // Get table structure (for debugging)
  static async getTableStructure() {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      const query = `DESCRIBE thirupathybright.database_orderregister`;
      const [rows] = await pool.execute(query);

      console.log('📋 Table structure:');
      rows.forEach(col => {
        console.log(`  - ${col.Field} (${col.Type})`);
      });

      return rows;
    } catch (error) {
      console.error('❌ Error getting table structure:', error);
      return null;
    }
  }

  // Get sample data (for debugging)
  static async getSampleOrders(limit = 5) {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      // Ensure limit is a positive integer (security: prevent SQL injection)
      const limitInt = Math.max(1, Math.min(100, parseInt(limit) || 5));

      // Note: LIMIT doesn't support placeholders in prepared statements, so we embed it directly
      // This is safe because we validate it's an integer above
      const query = `SELECT order_number, material_status FROM thirupathybright.database_orderregister LIMIT ${limitInt}`;
      const [rows] = await pool.execute(query);

      console.log(`📋 Sample orders (${rows.length} rows):`);
      rows.forEach(row => {
        console.log(`  - Order: ${row.order_number}, Status: ${row.material_status}`);
      });

      return rows;
    } catch (error) {
      console.error('❌ Error getting sample orders:', error);
      return [];
    }
  }

  // Get all unique marketing persons from order register
  static async getUniqueMarketingPersons() {
    try {
      if (!pool) {
        throw new Error('Database pool not initialized');
      }

      const query = `
        SELECT DISTINCT marketing_person
        FROM thirupathybright.Database_orderregister
        WHERE marketing_person IS NOT NULL AND marketing_person != ''
        ORDER BY marketing_person ASC
      `;
      const [rows] = await pool.execute(query);

      const marketingPersons = rows.map(row => row.marketing_person);
      console.log(`📋 Found ${marketingPersons.length} unique marketing persons:`, marketingPersons);

      return {
        success: true,
        count: marketingPersons.length,
        marketingPersons: marketingPersons
      };
    } catch (error) {
      console.error('❌ Error getting unique marketing persons:', error);
      return {
        success: false,
        error: error.message,
        marketingPersons: []
      };
    }
  }

  // Close database pool (for cleanup)
  static async close() {
    try {
      if (pool) {
        await pool.end();
        console.log('✅ Database pool closed');
      }
    } catch (error) {
      console.error('❌ Error closing database pool:', error);
    }
  }
}

// Initialize on module load
DatabaseHelper.init();

module.exports = DatabaseHelper;
