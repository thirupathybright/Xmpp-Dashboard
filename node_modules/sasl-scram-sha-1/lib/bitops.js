/* jslint bitwise: true */
var createHash = require('create-hash');
var createHmac = require('create-hmac');

exports.XOR = function (a, b) {
  var res = [];
  if (a.length > b.length) {
    for (var i = 0; i < b.length; i++) {
      res.push(a[i] ^ b[i]);
    }
  } else {
    for (var j = 0; j < a.length; j++) {
      res.push(a[j] ^ b[j]);
    }
  }
  return new Uint8Array(res);
};

exports.H = function (text) {
    return createHash('sha1').update(text).digest();
};

exports.HMAC = function (key, msg) {
    return createHmac('sha1', key).update(msg).digest();
};

exports.Hi = function (text, salt, iterations) {
    var concat = new Uint8Array(salt.length + 4);
    concat.set(salt);
    concat.set(new Uint8Array([0, 0, 0, 1]), salt.length);
    var ui1 = exports.HMAC(text, concat);
    var ui = ui1;
    for (var i = 0; i < iterations - 1; i++) {
        ui1 = exports.HMAC(text, ui1);
        ui = exports.XOR(ui, ui1);
    }

    return ui;
};

