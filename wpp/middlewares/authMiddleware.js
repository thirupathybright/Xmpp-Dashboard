// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ 
        status: 'error',
        message: 'No authorization header found' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        status: 'error',
        message: 'No token provided' 
      });
    }

    jwt.verify(token, 'secret_key', (err, decoded) => {
      if (err) {
        return res.status(403).json({ 
          status: 'error',
          message: 'Invalid or expired token' 
        });
      }
      
      // Set the user info in the request object
      req.user = decoded;
      next();
    });
  } catch (error) {
    return res.status(401).json({ 
      status: 'error',
      message: 'Authentication failed',
      error: error.message
    });
  }
};

module.exports = authMiddleware;