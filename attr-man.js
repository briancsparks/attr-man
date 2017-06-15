
/**
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const serverassist            = require('serverassist');
const http                    = require('http');
const urlLib                  = require('url');
const routes                  = require('./routes/routes');
const Router                  = require('routes');
const MongoClient             = require('mongodb').MongoClient;

const normlz                  = sg.normlz;
const registerAsService       = serverassist.registerAsService;
const registerAsServiceApp    = serverassist.registerAsServiceApp;

const ARGV                    = sg.ARGV();
const router                  = Router();
const mongoHost               = serverassist.mongoHost();
const myIp                    = serverassist.myIp();

const appName                 = 'api_dbgtelemetry';
const mount                   = 'xcc/api/v1/dbg-telemetry/';
const rewrite                 = 'api/v1/dbg-telemetry/';

const main = function() {
  return MongoClient.connect(mongoHost, (err, db) => {
    if (err)      { return sg.die(err, `Could not connect to DB ${mongoHost}`); }

    const port      = ARGV.port || 8105;

    var addOneRoute = function(router, path, fn) {
      console.log(`Adding route: ${path}`);
      router.addRoute(path, fn);
    };

    var addHandler  = function(restOfRoute, fn) {
      addOneRoute(router, normlz(`/${rewrite}/${restOfRoute}`), fn);
      addOneRoute(router, normlz(`/${mount}/${restOfRoute}`), fn);
      addOneRoute(router, normlz(`/${restOfRoute}`), fn);
    };

    return sg.__run([function(next) {
      return routes.addRoutes(db, addHandler, (err) => {
        return next();
      });
    }], function() {

      // Start the server
      const server = http.createServer((req, res) => {

        const url           = urlLib.parse(req.url, true);
        const pathname      = url.pathname;
        var   resPayload    = `Result for ${pathname}`;

        const host          = req.headers.host;
        const route         = router.match(pathname);

        // Do we have a route?
        if (!route || !_.isFunction(route.fn)) {
          res.statusCode  = 404;
          resPayload      = `404 - Not Found: ${host} / ${pathname}`;
          res.end(resPayload+'\n');
          return;
        }

        return sg.getBody(req, () => {
          return route.fn(req, res, route.params, route.splats, url.query, route);
        });
      });

      server.listen(port, myIp, () => {
        console.log(`${appName} running at http://${myIp}:${port}/`);

        registerAsServiceApp(appName, mount, {rewrite});

        registerMyService();
        function registerMyService() {
          setTimeout(registerMyService, 750);
          registerAsService(appName, `http://${myIp}:${port}`, myIp, 4000);
        }
      });

    });
  });
};

if (__filename === process.argv[1]) {
  main();
}

