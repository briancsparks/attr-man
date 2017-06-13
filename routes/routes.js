
/**
 *
 */
const sg                  = require('sgsg');
const _                   = sg._;

var lib = {};

lib.addRoutes = function(db, addHandler, callback) {
  var handlers = {};

  addHandler('upload', handlers.upload = function(req, res, params, splats, query) {
    const body      = req.bodyJson || {};
    const payload   = sg.extract(body, 'payload');
    const all       = sg.extend(body || {}, params || {}, query ||{});

    console.log('all:', all);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Hello World\n');
  });

  return callback();
};

_.each(lib, (value, key) => {
  exports[key] = value;
});


