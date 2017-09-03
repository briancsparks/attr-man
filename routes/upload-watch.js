
/**
 *  Handlers for AttributeMan(ager).
 *
 *  /upload -- Upload a list of attribute objects.
 *  /watch  -- An HTTP long-poll end-point that will receive a 'stream' of attributes
 *             as multiple response bodies.
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const serverassist            = sg.include('serverassist') || require('serverassist');
const AWS                     = require('aws-sdk');

const setOnn                  = sg.setOnn;
const verbose                 = sg.verbose;
const inspect                 = sg.inspectFlat;
const registerAsService       = serverassist.registerAsService;
const registerAsServiceApp    = serverassist.registerAsServiceApp;
const configuration           = serverassist.configuration;

const appId                   = 'sa_dbgtelemetry';
const mount                   = 'sa/api/v1/dbg-telemetry/';
const projectId               = 'sa';

const appRecord = {
  projectId,
  mount,
  appId,
  route               : '/:project(sa)/api/v:version/dbg-telemetry/',
  isAdminApp          : false,
  useHttp             : true,
  useHttps            : true,
  requireClientCerts  : false
};

var lib = {};

lib.addRoutes = function(addRoute, onStart, db, callback) {
  var r;
  var watchers = {}, data = {};
  var uploads     = {};
  var itemsForS3  = {};

  var attrMan = db.collection('attributeMan');

  const s3 = new AWS.S3();

  /**
   *  /upload handler
   */
  const upload = function(req, res, params, splats, query) {
    var   result    = {count:0, attrCount:0};
    const origAll   = sg.deepCopy(sg.extend(req.bodyJson || {}, params || {}, query || {}));

    const body      = sg.extend(req.bodyJson || {});
    const payload   = sg.extract(body, 'payload');
    const all       = sg.extend(body || {}, params || {}, query ||{});
    const sessionId = sg.extract(all, 'sessionId') || 'defSession';
    const clientId  = sg.extract(all, 'clientId');

    //console.log({sessionId, clientId, all, splats, payload});

    var sessionData   = data[sessionId]         = data[sessionId]         || {};
    var sessionItems  = itemsForS3[sessionId]   = itemsForS3[sessionId]   || {count:0, ctime:_.now(), mtime:_.now()};

    sessionItems.payload = [...(sessionItems.payload || []), ...(origAll.payload || [])];
    _.each(_.keys(_.omit(origAll, 'payload', 'count')), (key) => {
      sessionItems[key] = sg.addToSet(origAll[key], (sessionItems[key] || []));
    });
    sessionItems.count += 1;
    sessionItems.mtime  = _.now();

    //// Add back in to see accumulation of sessionItems
    //var silog = sg.deepCopy(sessionItems);
    //silog.payload = silog.payload.length;
    //console.error('si', silog, _.keys(origAll));

    // Put into s3
    (function() {
      var uploadData = {
        sessionId   : sessionItems.sessionId[0],
        clientId    : sessionItems.clientId[0],
        sessionIds  : sessionItems.sessionId,
        clientIds   : sessionItems.clientId
      };

      uploadData = sg.reduce(_.keys(_.omit(sessionItems, 'sessionId', 'clientId', 'payload')), uploadData, (m, key) => {
        return sg.kv(m, key, sessionItems[key]);
      });

      uploadData.elapsed = uploadData.mtime - uploadData.ctime;
      uploadData.payload = sessionItems.payload;

      var params = {
        Body:         JSON.stringify(uploadData),
        Bucket:       bucketName(),
        Key:          `${sessionId}.json`,
        ContentType:  'application/json'
      };

      return s3.putObject(params, (err, data) => {
        console.log(`added ${sessionItems.payload.length} to S3:`, err, data);
      });
    }());

    // key/values that should be put onto all items
    var kvAll       = {sessionId, clientId};

    _.each(payload, (payloadItem_) => {
      const payloadItem = sg.extend(payloadItem_, kvAll);
      verbose(3, `payload item`, payloadItem);

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
    verbose(1, {sessionId, result});

    res.statusCode  = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  };

  const watch = function(req, res, params, splats, query) {
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
  };

  return sg.__run([function(next) {
    registerAsServiceApp(appId, mount, appRecord, next);

  }, function(next) {
    return configuration({}, {}, (err, r_) => {
      if (err) { return sg.die(err, callback, 'addRoutesToServers.configuration'); }

      r = r_;
      return next();
    });

  }, function(next) {
    addRoute(`/${mount}`, '/upload',    upload);
    addRoute(`/${mount}`, '/upload/*',  upload);

    addRoute(`/telemetry/xapi/v1`, '/watch',     watch);
    addRoute(`/telemetry/xapi/v1`, '/watch/*',   watch);

    return next();

  }, function(next) {

    // Add startup notification handler for uploader
    onStart.push(function(port, myIp) {
      const myServiceLocation   = `http://${myIp}:${port}`;

      console.log(`${sg.pad(appId, 30)} : [${myServiceLocation}/${mount}]`);
      registerMyService();

      function registerMyService() {
        setTimeout(registerMyService, 750);
        registerAsService(appId, myServiceLocation, myIp, 4000);
      }
    });

    // Add startup notification handler for xapi
    onStart.push(function(port, myIp) {
      const myServiceLocation   = `http://${myIp}:${port}`;
      const xapiAppId = 'sa_xapi_telemetry_1';

      console.log(`${sg.pad(xapiAppId, 30)} : [${myServiceLocation}]`);
      registerMyService();

      function registerMyService() {
        setTimeout(registerMyService, 750);
        registerAsService(xapiAppId, myServiceLocation, myIp, 4000);
      }
    });

    return next();

  }], function() {
    return callback();
  });
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

function bucketName() {
  if (sg.isProduction()) {
    return 'sa-telemetry-netlab-asis-pub';
  }

  return 'sa-telemetry-netlab-asis-test';
}

