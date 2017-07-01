
/**
 *  Handlers for AttributeMan(ager).
 *
 *  /upload -- Upload a list of attribute objects.
 *  /watch  -- An HTTP long-poll end-point that will receive a 'stream' of attributes
 *             as multiple response bodies.
 *
 */
const sg                  = require('sgsg');
const _                   = sg._;

const setOnn              = sg.setOnn;
const verbose             = sg.verbose;
const inspect             = sg.inspectFlat;

var lib = {};

lib.addRoutes = function(db, addHandler, callback) {
  var handlers = {}, watchers = {}, data = {};

  var attrMan = db.collection('attributeMan');

  /**
   *  /upload handler
   */
  addHandler('/upload/*', handlers.upload = function(req, res, params, splats, query) {
    var   result    = {count:0, attrCount:0};
    const body      = sg.extend(req.bodyJson || {});
    const payload   = sg.extract(body, 'payload');
    const all       = sg.extend(body || {}, params || {}, query ||{});
    const sessionId = sg.extract(all, 'sessionId') || 'defSession';

    //console.log({all, splats, payload});

    var sessionData = data[sessionId] = data[sessionId] || {};

    // key/values that should be put onto all items
    var kvAll = {sessionId};

    _.each(payload, (payloadItem_) => {
      const payloadItem = sg.extend(payloadItem_, kvAll);

      result.count += 1;

      // Put the item into each watcher queue
      _.each(watchers, (watcher, id) => {
        watcher.push(sg.extend(payloadItem));     // extend(), so that it is 'final'
      });

      // Set the attribute (on the right object) within the session data
      const key         = sg.extract(payloadItem, 'key');
      const value       = sg.extract(payloadItem, 'value');

      setOnn(sessionData, [payloadItem.type, payloadItem.id, key], value);
      result.attrCount += 1;

      _.each(payloadItem, (payloadValue, payloadKey) => {
        setOnn(sessionData, [payloadItem.type, payloadItem.id, payloadKey], payloadValue);
        result.attrCount += 1;
      });
    });

    result.ok       = true;
    verbose(3, `Received: ${sessionId}:`, result);
    console.log(inspect({received: sessionId, result}));

    res.statusCode  = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });

  addHandler('/watch/*', handlers.watch = function(req, res, params, splats, query) {
    const all       = sg.extend(req.bodyJson || {}, params || {}, query || {});
    const id        = sg.extract(all, 'watch-id,id')  || 'defId';
    const sessionId = sg.extract(all, 'session-id')   || 'defSession';

    if (!watchers[id]) {
      verbose(2, `New watcher: ${id}`);
    }

    watchers[id] = watchers[id] || [];

    one();
    function one() {
      var result;
      if (watchers[id].length === 0) { return setTimeout(one, 100); }

      result          = {ok:true, items:_.toArray(watchers[id])};
      watchers[id]   = [];

      verbose(2, `Sending to watcher: ${id}:`, sg.extend(_.omit(result, 'items'), {count: result.items.length}));

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


