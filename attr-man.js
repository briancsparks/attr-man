
/**
 *  AttributeMan(ager) is a simple Node.js JSON server that facilitates the reporting
 *  of an attribute stream. An attribute stream is a good way to log information for
 *  debugging.
 *
 *  # How it Works
 *
 *  ... (the rest of this note is at the bottom of this file.)
 *
 */

//
//  This file is just the Node.js HttpServer. routes/routes.js has the real intelligence
//  of the system.
//

const sg                      = require('sgsg');
const _                       = sg._;
const serverassist            = sg.include('serverassist') || require('serverassist');
const http                    = require('http');
const urlLib                  = require('url');
const routes                  = require('./routes/routes');
const Router                  = require('routes');
const MongoClient             = require('mongodb').MongoClient;

const verbose             = sg.verbose;
const normlz                  = sg.normlz;
const registerAsService       = serverassist.registerAsService;
const registerAsServiceApp    = serverassist.registerAsServiceApp;

const ARGV                    = sg.ARGV();
const router                  = Router();
const mongoHost               = serverassist.mongoHost();
const myIp                    = serverassist.myIp();

const appName                 = 'sa_dbgtelemetry';
const mount                   = 'sa/api/v1/dbg-telemetry/';
const projectId               = 'sa';

const main = function() {
  return MongoClient.connect(mongoHost, (err, db) => {
    if (err)      { return sg.die(err, `Could not connect to DB ${mongoHost}`); }

    const port      = ARGV.port || 8105;

    var addOneRoute = function(router, path, fn) {
      verbose(2, `Adding route: ${path}`);
      router.addRoute(path, fn);
    };

    var addHandler  = function(restOfRoute, fn) {
      addOneRoute(router, normlz(`/${mount}/${restOfRoute}`), fn);
    };

    return sg.__run([function(next) {
      return routes.addRoutes(db, addHandler, (err) => {
        return next();
      });
    }], function() {

      //----------------------------------------------------------------------
      // Start the HTTP server
      //----------------------------------------------------------------------

      // The viewer web-app gets the current items here
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
        verbose(2, `${appName} running at http://${myIp}:${port}/`);

        registerAsServiceApp(appName, mount, {projectId});

        registerMyService();
        function registerMyService() {
          setTimeout(registerMyService, 750);
          registerAsService(appName, `http://${myIp}:${port}`, myIp, 4000);
        }
      });

    });
  });
};

if (sg.callMain(ARGV, __filename)) {
  main();
}

/**
 *  # How it Works
 *
 *  Your program sends telemetry to a collector of some sort. Typically, you use
 *  printf-style log statments that go to a file, and then the file is usually
 *  able to be tail'ed.
 *
 *  With attr-man, instead you send key/value pairs to a collector. The collector
 *  then sends the info to attr-man. When logging, you send one or more key/value
 *  pairs with one call to the logger, but the logger sends each key/value pair
 *  to the collector separately as an attribute -- and includes other meta-information
 *  along with it, like when it happened, and who did the logging.
 *
 *  The _logger_ does not exist as part of attr-man, yet, but a collector does.
 *
 *  **udp-json.js** is a collector that listens on --udp-port=50505 for packets - one
 *  packet per attribute. The packet is utf8 data which consists of a control sequence,
 *  followed by white space followed by a JSON object. The JSON object is the
 *  attribute data, with well-known keys, and the control sequence is alpha followed
 *  by an identifier. Currently 'pNNN' is the only control sequence and it means that
 *  this packet is (p)ayload number NNN -- so the collector can ack having gotten the
 *  whole stream.
 *
 *  **attr-man.js** and **routes.js** make up the JSON server. attr-man.js is simply
 *  a Node.js HttpServer object that receives the typical `req, res` pair. routes.js
 *  has the route handlers (one to allow the collector to upload the attributes, and
 *  one that allows someone like a web page to query for the data.
 *
 *  ## Notes
 *
 *  * The collector listens over UDP to make it as simple as possilbe for the logger
 *    to send data -- it doesn't have to worry about connecting or connection state
 *    at all.
 *  * Since the collector uses UDP (and is subject to the adapters MTU), the system
 *    sends only one attribute per packet.
 *  * Since it is sent over UDP (an unreliable protocol family), each packet has
 *    sequence information.
 *  * The collector sends many attributes to the JSON server in one HTTP POST.
 *
 */
