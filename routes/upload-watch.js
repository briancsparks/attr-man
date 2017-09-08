
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
const deref                   = sg.deref;
const verbose                 = sg.verbose;
const myColor                 = serverassist.myColor();
const myStack                 = serverassist.myStack();
const inspect                 = sg.inspectFlat;
const extractClientId         = serverassist.extractClientId;
const registerAsService       = serverassist.registerAsService;
const registerAsServiceApp    = serverassist.registerAsServiceApp;
const configuration           = serverassist.configuration;

const appId                   = 'sa_attrstream';
const mount                   = '*/api/v1/attrstream/';
const projectId               = 'sa';

const appRecord = {
  projectId,
  mount,
  appId,
  route               : '*/api/v:version/attrstream/',
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
    var   result        = {count:0, attrCount:0};
    const origAllJson   = JSON.stringify(sg.extend(req.bodyJson || {}, params || {}, query || {}));

    const body          = sg.extend(req.bodyJson || {});
    const payload       = sg.extract(body, 'payload');
    const all           = sg.extend(body || {}, params || {}, query ||{});

    const sessionId     = sg.extract(all, 'sessionId')      || 'defSession';
    const projectId     = sg.extract(all, 'projectId')      || 'sa';
    const clientId      = extractClientId(all, 'clientId');

    const bucket    = bucketName(projectId);
    if (!bucket) {
      return serverassist._404(req, res, sg.extend({ok:false}, result), `No bucket for ${projectId}`);
    }

    const s3Params  = serverassist.bucketParams(clientId, sessionId, bucket, origAllJson);
    return s3.putObject(s3Params, (err, data) => {
      console.log(`added ${payload.length} to S3:`, err, data);

      result.ok       = true;
      serverassist._200(req, res, result);
    });
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
      //console.log('configuration', sg.inspect(r.result.app_prj));

      //_.each(r.result.app_prj, (app_prj, app_prjName) => {
      //  if (app_prj.app.appId !== appId) { return; }    /* this is not my app */
      //  console.log(`my app: ${app_prjName}`, sg.inspect(app_prj));
      //});

      return next();
    });

  }, function(next) {

    //
    //  Add routes for the public APIs
    //

    console.log(`  -- attribute stream public routes:`);
    _.each(r.result.app_prj, (app_prj, app_prjName) => {

      if (app_prj.app.appId !== appId) { return; }    /* this is not my app */

      const [projectId, appName]  = app_prjName.split('_');
      const myMount               = deref(app_prj, [myStack, myColor, 'mount']) || '';

      addRoute(`/:projectId(${projectId})/api/v:version/attrstream`, `/upload`,       upload, app_prjName);
      addRoute(`/:projectId(${projectId})/api/v:version/attrstream`, `/upload/*`,     upload, app_prjName);

      // Add startup notification handler for uploader
      onStart.push(function(port, myIp) {
        const myServiceLocation   = `http://${myIp}:${port}`;

        console.log(`${sg.pad(app_prjName, 35)} [${myServiceLocation}] (for /${myMount})`);
        registerMyService();

        function registerMyService() {
          setTimeout(registerMyService, 750);
          registerAsService(app_prjName, myServiceLocation, myIp, 4000);
        }
      });
    });

    return next();

  }, function(next) {

    //
    //  Add routes for the protected (xapi) APIs
    //

    console.log(`  -- attribute stream protected (xapi) routes:`);
    _.each(r.result.app_prj, (app_prj, app_prjName) => {

      if (app_prj.app.appId !== appId) { return; }    /* this is not my app */

      const [projectId, appName]  = app_prjName.split('_');

      addRoute(`/attrstream/xapi/:projectId(${projectId})/v:version`, '/watch',       watch,  app_prjName);
      addRoute(`/attrstream/xapi/:projectId(${projectId})/v:version`, '/watch/*',     watch,  app_prjName);

      // Add startup notification handler for xapi
      onStart.push(function(port, myIp) {
        const myServiceLocation   = `http://${myIp}:${port}`;
        const xapiAppId           = `${projectId}_xapi_${appName}_1`;

        console.log(`${sg.pad(xapiAppId, 35)} [${myServiceLocation}]`);
        registerMyService();

        function registerMyService() {
          setTimeout(registerMyService, 750);
          registerAsService(xapiAppId, myServiceLocation, myIp, 4000);
        }
      });
    });

    addRoute(`/attrstream/xapi/v:version`, '/watch',     watch, `${appId} (to discover projectId)`);
    addRoute(`/attrstream/xapi/v:version`, '/watch/*',   watch, `${appId} (to discover projectId)`);

    return next();

  }], function() {
    return callback();
  });


  /**
   *  Returns the bucket name that should be used for the project.
   */
  function bucketName(projectId) {

    const app_prjName   = `${projectId}_attrstream`;
    const app_prj       = deref(r, ['result', 'app_prj', app_prjName, myStack, myColor]);

    const vers = sg.isProduction() ? 'prod' : 'test';

    const result = deref(app_prj, ['attrstream', 'buckets', 'asis', vers]);
    return result;
  }
};

_.each(lib, (value, key) => {
  exports[key] = value;
});


