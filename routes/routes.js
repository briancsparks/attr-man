
/**
 *
 */
const sg                  = require('sgsg');
const _                   = sg._;

const setOnn              = sg.setOnn;

var lib = {};

lib.addRoutes = function(db, addHandler, callback) {
  var handlers = {}, watchData = {}, data = {};

  var attrMan = db.collection('attributeMan');

  addHandler('/upload/*', handlers.upload = function(req, res, params, splats, query) {
    var   result    = {count:0};
    const body      = sg.extend(req.bodyJson || {});
    const payload   = sg.extract(body, 'payload');
    const all       = sg.extend(body || {}, params || {}, query ||{});
    const sessionId = sg.extract(all, 'sessionId') || 'defSession';

    //console.log({all, splats, payload});

    var sessionData = data[sessionId] = data[sessionId] || {};

    _.each(payload, (payloadItem_) => {
      const payloadItem = sg.extend(payloadItem_, {sessionId});

      _.each(watchData, (item, id) => {
        watchData[id].push(sg.extend(payloadItem));
      });

      const key         = sg.extract(payloadItem, 'key');
      const value       = sg.extract(payloadItem, 'value');

      setOnn(sessionData, [payloadItem.type, payloadItem.id, key], value);
      const dbItem = sessionData[payloadItem.type][payloadItem.id];
      result.count += 1;

      _.each(payloadItem, (value, key) => {
        dbItem[key]   = value;
        result.count += 1;
      });
    });

    result.ok       = true;
    console.log(`Received: ${sessionId}:`, result);

    res.statusCode  = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });

  addHandler('/watch/*', handlers.watch = function(req, res, params, splats, query) {
    const all       = sg.extend(req.bodyJson || {}, params || {}, query || {});
    const id        = sg.extract(all, 'watch-id,id')  || 'defId';
    const sessionId = sg.extract(all, 'session-id')   || 'defSession';

    watchData[id] = watchData[id] || [];

    one();
    function one() {
      var result;
      if (watchData[id].length == 0) { return setTimeout(one, 100); }

      result          = {ok:true, items:_.toArray(watchData[id])};
      watchData[id]   = [];

      console.log(`Sending to watcher: ${id}:`, sg.extend(_.omit(result, 'items'), {count: result.items.length}));

      res.statusCode  = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    }
  });

  return callback();
};

_.each(lib, (value, key) => {
  exports[key] = value;
});


