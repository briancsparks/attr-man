
/**
 *  Listen on UDP --port for JSON; send the JSON to a dbg-telemetry web service.
 *
 *      --port  - The port on which to listen
 *      --fqdn  - The FQDN (domain name) of the HQ server
 *
 *  There is one dgram socket listener, which will receive one JSON telemetry object
 *  per recv, and parse it. It then sends the JSON to a `send` function. The send
 *  function queues the JSON, and uploads it to the dbg-telemetry service every
 *  so often.
 */
const sg                      = require('sgsg');
const _                       = sg._;
const serverassistLib         = sg.include('serverassist') || require('serverassist');
const dgram                   = require('dgram');
const crypto                  = require('crypto');
const request                 = sg.extlibs.superagent;
const moment                  = sg.extlibs.moment;

const ARGV                    = sg.ARGV();
const normlz                  = sg.normlz;
const argvGet                 = sg.argvGet;
const verbose                 = sg.verbose;
const clientStart             = serverassistLib.client.clientStart;

const version                 = 1;

var   sessions                = {};

var lib = {};

var main = function(argv) {
  const udpPort           = argvGet(argv, 'udp-port,port')        || 50505;
  const upTimeout         = argvGet(argv, 'upload-timeout,to')    || 5000;
  const upMaxCount        = argvGet(argv, 'upload-max,max')       || 275;
  var   clientId          = argvGet(argv, 'client-id,client');
  const clientPrefix      = argvGet(argv, 'client-prefix,pre');
  const defSessionId      = argvGet(argv, 'session-id')           || 'session_'+_.now()

  // Configuration of link to upload
  var   partnerId         = argvGet(argv, 'partner-id,partner')   || 'HP_SA_SERVICE';
  const service           = argvGet(argv, 'service')              || 'attrstream';
  const rsvr              = argvGet(argv, 'rsvr');

  var   serverassists     = {};
  var   sendPayload;
  var   sessions          = {};
  var   sessionFlows      = {};

  var csOptions = sg.extend({partnerId}, {version}, {rsvr});

  return sg.__run([function(next) {

    return sg.getHardwareId((err, hardwareId) => {

      if (sg.ok(err, hardwareId)) {
        const shasum = crypto.createHash('sha512');
        shasum.update(hardwareId);
        clientId = shasum.digest('base64').replace(/[^a-z0-9]/gi, '0').substr(0, 64);
        csOptions = sg.extend(csOptions, {clientId});
      }

      if (clientPrefix && csOptions.clientId) {
        clientId = csOptions.clientId = `${clientPrefix}-${csOptions.clientId}`.substr(0, 64);
      }

      console.log(`Using clientId: ${clientId}`);

      return next();
    });

  }], function() {

    const startSession = function(sessionId, callback) {

      csOptions.sessionId = sessionId;
      const localServerassist = clientStart(csOptions, function(err, config) {
        if (sg.ok(err)) {
          serverassists[sessionId] = localServerassist;

          _.each(serverassists[sessionId].upstreams, (upstream, key) => {
            console.log(`  Using upstream: ${sg.lpad(key, 20)} ->> ${upstream}`);
          });
        }
        return callback(err, config);
      });
    };

    //---------------------------------------------------------
    // Listen on UDP and upload incoming
    //---------------------------------------------------------

    const server = dgram.createSocket('udp4');

    /**
    *  Handle the UDP packet.
    */
    server.on('message', (msg_, rinfo) => {

      const socket        = `${rinfo.address}:${rinfo.port}`;
      const niceSocket    = socket.replace(/[^a-z0-9]/ig, '_');
      const isNewSession  = !(niceSocket in sessions);
      var   payload, sessionId;

      sessions[niceSocket] = sessions[niceSocket] || (clientId+'-'+moment().format('YYYYMMDDHHmmssSSS'));

      // ----- We got a packet. It looks like this:
      //
      //       |p159 {"who":"snmp","when":123,...}\n|

      var msg = msg_.toString();

      // Clean the message up (clean trailing white-space)
      msg = msg.replace(/[\n\t ]+$/g, '');

      // See if this is the right format m[1] === 'p159'; m[2] === {"who":"snmp","when":123,...}
      const m = /^(\S+)\s+(.*)$/.exec(msg);
      if (m && m[2] && (payload = sg.safeJSONParse(m[2], null))) {

        // Make sure there is a sessionId
        sessionId = sg.extract(payload, 'sessionId') || sessions[niceSocket];

        showPayload(rinfo, payload);

        return sg.__run([function(next) {
          if (!isNewSession) { return next(); }

          console.log(`New session ${sessionId}`);
          return startSession(sessionId, (err, config) => {
            return next();
          });
        }], function() {
          sendPayload({payload, sessionId}, rinfo);
        });

      } else {
        // The payload wasn't the expected format
        console.error('no m');
      }
    });

    /**
    *  Once we are listening for the magic UDP packets, get our upstream
    *  information from the HQ server.
    */
    server.on('listening', () => {
      const address = server.address();
      console.log(`UDP server listening on ${address.address}:${address.port}`);
    });

    //---------------------------------------------------------
    // Upload
    //---------------------------------------------------------
    var uploadTimer, uploadSession;

    sendPayload = function(body, rinfo, callback_) {
      var callback = callback_ || function(){};

      verbose(4, `From ${rinfo.address}:${rinfo.port}`, body);

      if (!body || !body.payload)           { return callback(sg.toError('ENOPAYLOAD')); }

      const payload     = sg.extract(body, 'payload');
      const sessionId   = sg.extract(body, 'sessionId') || defSessionId;

      var   sessionFlow = sessionFlows[sessionId] = sessionFlows[sessionId] || [];

      // Push the data into an array to be uploaded
      sessionFlow.push(payload);

      // ---------- If we do not have an uploader, do not bother, yet ----------
      if (!serverassists[sessionId]) { return callback(sg.toError('ENOUPSTREAM')); }



      // Have we collected enough?
      if (sessionFlow.length >= upMaxCount) {
        verbose(3, `Flushing ${sessionId}, count: ${sessionFlow.length} -- viaMax? false`);

        if (uploadTimer) {
          clearTimeout(uploadTimer);
          uploadTimer = null;
        }

        return uploadSession('count', sessionId, err => {
          return callback(err, ..._.rest(arguments));
        });
      }

      /* otherwise -- let data accumulate for a while */
      uploadViaTimer();
      function uploadViaTimer() {
        // If we have a timer, that means someone is already going to call uploadSession once the timer fires.
        if (!uploadTimer) {
          uploadTimer = sg.setTimeout(upTimeout, () => {
            verbose(3, `Timeout-Flushing ${sessionId}, count: ${sessionFlows[sessionId].length}`);

            uploadTimer = null;
            uploadSession('timeout', sessionId, err => {
              return callback(err, ..._.rest(arguments));
            });
          });
        } else {
          verbose(4, `fizzle ${sessionId}, count: ${sessionFlows[sessionId].length}`);
        }
      }
    };

    uploadSession = function(whichOne, sessionId, callback_) {
      const callback      = callback_ || function(){};

      const sessionFlow   = sg.deepCopy(sessionFlows[sessionId]);
      var   body          = sg.extend({sessionId, clientId}, {partnerId}, {version});

      uploadTimer         = null;
      delete sessionFlows[sessionId];

      if (sessionFlow) {
        body.payload = sessionFlow;

        return serverassists[sessionId].POST(service, '/upload/', /*query=*/ {}, body, function(err, result) {
          logit(`Uploading-(${sg.pad(whichOne,7)})`, sg.pad(''+sessionFlow.length,6), `${sessionId.substr(0,8)}...-${_.last(sessionId.split('-'))}`, err, result);
          if (err)  { return callback(err); }

          return callback(null, result);
        });
      }
    };

    // Cleanup if we have an error
    server.on('error', (err) => {
      console.error(`UDP server error: ${err.stack}`);
      server.close();
    });

    // Bind to localhost
    server.bind(udpPort, '127.0.0.1');

    report();
    function report() {
      //setTimeout(report, 5000);
      console.log('SessionIds:', _.keys(sessions));
    }
  });
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

if (sg.callMain(ARGV, __filename)) {
  main(ARGV.getParams({}));
}

function showPayload(rinfo, payload_) {
  var   payload = sg.deepCopy(payload_);
  const who     = sg.extract(payload, 'who');
  const when    = sg.extract(payload, 'when');

  verbose(4, `UDP Message from ${rinfo.port}: ${sg.pad(who, 16)}@ ${when} |${JSON.stringify(payload)}|`);
}

function logit() {
  var msg = _.map(arguments, arg => {
    if (_.isString(arg)) { return arg; }
    return sg.inspect(arg);
  });

  console.log(msg.join(', '));
}

