// SQL Database Authentication Configuration
// MySQL Database credentials for Thirupathybright Industries

const DATABASES = {
  'default': {
    'ENGINE': 'mysql',
    'NAME': 'thirupathybright',
    'USER': 'thirupathybright',
    'PASSWORD': 'Thirupathybright@12345',
    'HOST': '127.0.0.1',
    'PORT': '3306',
    'connectionLimit': 10,
    'waitForConnections': true,
    'queueLimit': 0
  }
};

module.exports = DATABASES;
