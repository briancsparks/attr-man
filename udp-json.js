
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
const sg                = require('sgsg');
const _                 = sg._;
const helpers           = require('../helpers');
const dgram             = require('dgram');
const request           = sg.extlibs.superagent;

const ARGV              = sg.ARGV();
const normlz            = sg.normlz;
const argvGet           = sg.argvGet;
const verbose           = sg.verbose;
const fetch             = helpers.fetch;
const setPrefix         = helpers.setPrefix;

var lib = {};

var udp2DbgTelemetry = function(argv, context, callback) {
  const telemetryFqdn     = argvGet(argv, 'fqdn')                 || 'hq.mobilewebassist.net';
  const telemetryVer      = argvGet(argv, 'version,v')            || 'v1';
  const telemetryRoute    = argvGet(argv, 'route')                || normlz(`/sa/api/${telemetryVer}/dbg-telemetry/upload/`);
  const telemetryEndpoint = argvGet(argv, 'endpoint')             || normlz(`http://${telemetryFqdn}/${telemetryRoute}`);
  const udpPort           = argvGet(argv, 'udp-port,port')        || 50505;
  const upTimeout         = argvGet(argv, 'upload-timeout,to')    || 1000;
  const upMaxCount        = argvGet(argv, 'upload-max,max')       || 15;
  const defSessionId      = argvGet(argv, 'session-id')           || 'session_'+_.now()

  var   sendPayload;
  var   sessions          = {};
  var   sessionFlows      = {};

  //---------------------------------------------------------
  // Listen on UDP and upload incoming
  //---------------------------------------------------------

  const server = dgram.createSocket('udp4');

  server.on('message', (msg_, rinfo) => {

    const socket = `${rinfo.address}:${rinfo.port}`;
    var   payload, sessionId;

    // ----- We got a packet. It looks like this:
    //
    //       |p159 {"who":"snmp","when":123,...}\n|

    var msg = msg_.toString();

    // Clean the message up (clean trailing white-space)
    msg = msg.replace(/[\n\t ]+$/g, '');

    verbose(3, `UDP Message from ${rinfo.address}:${rinfo.port}: |${msg}|`);

    // See if this is the right format m[1] === 'p159'; m[2] === {"who":"snmp","when":123,...}
    const m = /^(\S+)\s+(.*)$/.exec(msg);
    if (m && m[2] && (payload = sg.safeJSONParse(m[2], null))) {

      // Make sure there is a sessionId
      sessionId = sg.extract(payload, 'sessionId') || ('socket_'+socket.replace(/[^a-z0-9_]/ig, '_'));

      sendPayload({payload, sessionId}, rinfo);

    } else {
      // The payload wasn't the expected format
      console.error('no m');
    }
  });


  //---------------------------------------------------------
  // Upload
  //---------------------------------------------------------
  var uploadTimer, uploadSession;

  sendPayload = function(body, rinfo, callback_) {
    var callback = callback_ || function(){};

    verbose(3, `From ${rinfo.address}:${rinfo.port}`, body);

    if (!body || !body.payload)           { return callback(sg.toError('ENOPAYLOAD')); }

    const payload     = sg.extract(body, 'payload');
    const sessionId   = sg.extract(body, 'sessionId') || defSessionId;

    var   sessionFlow = sessionFlows[sessionId] = sessionFlows[sessionId] || [];

    // Push the data into an array to be uploaded
    sessionFlow.push(payload);

    // Have we collected enough?
    if (sessionFlow.length >= upMaxCount) {
      verbose(2, `Flushing ${sessionId}, count: ${sessionFlow.length}`);
      verbose(3, `Flushing ${sessionId}, count: ${sessionFlow.length}`, payload, sessionFlow);

      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
      }

      return uploadSession(sessionId, callback);
    }

    /* otherwise -- let data accumulate for a while */

    // If we have a timer, that means someone is already going to call uploadSession once the timer fires.
    if (!uploadTimer) {
      uploadTimer = setTimeout(() => {
        verbose(2, `Timeout-Flushing ${sessionId}, count: ${sessionFlows[sessionId].length}`);
        verbose(3, `Timeout-Flushing ${sessionId}, count: ${sessionFlows[sessionId].length}`, payload, sessionFlows[sessionId]);

        uploadTimer = null;
        uploadSession(sessionId, callback);
      }, upTimeout);
    }
  };

  uploadSession = function(sessionId, callback_) {
    const callback      = callback_ || function(){};
    const sessionFlow   = sg.deepCopy(sessionFlows[sessionId]);
    const urlPath       = '/dbg-telemetry/upload/';
    var   body          = {sessionId};

    uploadTimer         = null;
    delete sessionFlows[sessionId];

    if (sessionFlow) {
      body.payload = sessionFlow;

      //console.log(`Uploading sessionFlow ${sessionId}, length: ${sessionFlow.length}, endpoint: ${endpoint}`);
      return fetch(urlPath, body, function(err, result) {
        if (err)  { return callback(err); }

        return callback(null, result);
      });
    }
  };

  // Message when we are listening
  server.on('listening', () => {
    const address = server.address();
    console.log(`UDP server listening on ${address.address}:${address.port}; sending to ${telemetryFqdn}`);

    setPrefix(`http://hq.${telemetryFqdn}/sa/`);

    const body      = {partnerId:"HP_SA_SERVICE", version:1};
    const urlPath   = '/clientStart/?clientId=asdf';
    return fetch(urlPath, body, function(err, result) {
      if (err) { console.error(err); return; }

      setPrefix(result.upstream);
    });
  });

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
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

if (sg.callMain(ARGV, __filename)) {
  udp2DbgTelemetry(ARGV.getParams({}), {}, function(){});
}