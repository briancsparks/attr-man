
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
const request                 = sg.extlibs.superagent;

const ARGV                    = sg.ARGV();
const normlz                  = sg.normlz;
const argvGet                 = sg.argvGet;
const verbose                 = sg.verbose;
const clientStart             = serverassistLib.client.clientStart;

const partnerId               = 'HP_SA_SERVICE';
const version                 = 1;

var lib = {};

var udp2DbgTelemetry = function(argv, context, callback) {
  const udpPort           = argvGet(argv, 'udp-port,port')        || 50505;
  const upTimeout         = argvGet(argv, 'upload-timeout,to')    || 1000;
  const upMaxCount        = argvGet(argv, 'upload-max,max')       || 15;
  const clientPrefix      = argvGet(argv, 'client-prefix,pre');
  const defSessionId      = argvGet(argv, 'session-id')           || 'session_'+_.now()

  var   serverassist;
  var   sendPayload;
  var   sessions          = {};
  var   sessionFlows      = {};

  //---------------------------------------------------------
  // Listen on UDP and upload incoming
  //---------------------------------------------------------

  const server = dgram.createSocket('udp4');

  /**
   *  Once we are listening for the magic UDP packets, get our upstream
   *  information from the HQ server.
   */
  server.on('listening', () => {
    const address = server.address();
    console.log(`UDP server listening on ${address.address}:${address.port}`);

    var csOptions = sg.extend({partnerId}, {version});
    return sg.getHardwareId((err, hardwareId) => {
      if (sg.ok(err, hardwareId)) {
        csOptions = sg.extend(csOptions, {clientId: hardwareId});
      }

      if (clientPrefix && csOptions.clientId) {
        csOptions.clientId = `${clientPrefix}-${csOptions.clientId}`;
      }

      const localServerassist = clientStart(csOptions, function(err, config) {
        if (sg.ok(err)) {
          serverassist = localServerassist;
          console.log(`Sucessfully got startup info from ${serverassist.upstreams.sa_hq}`)
        }
        //console.log('clientStart:', csOptions, err, config, serverassist);
      });
    });

  });

  /**
   *  Handle the UDP packet.
   */
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

      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
      }

      return uploadSession(sessionId, err => {
        if (err && err.name === 'ENOUPSTREAM') { return uploadViaTimer(); }

        return callback(err, ..._.rest(arguments));
      });
    }

    /* otherwise -- let data accumulate for a while */
    uploadViaTimer();
    function uploadViaTimer() {
      // If we have a timer, that means someone is already going to call uploadSession once the timer fires.
      if (!uploadTimer) {
        uploadTimer = sg.setTimeout(upTimeout, () => {
          verbose(2, `Timeout-Flushing ${sessionId}, count: ${sessionFlows[sessionId].length}`);

          uploadTimer = null;
          uploadSession(sessionId, err => {
            if (err && err.name === 'ENOUPSTREAM') { return sg.setTimeout(100, uploadViaTimer); }

            return callback(err, ..._.rest(arguments));
          });
        });
      }
    }
  };

  uploadSession = function(sessionId, callback_) {
    const callback      = callback_ || function(){};

    if (!serverassist) { return callback(sg.toError('ENOUPSTREAM')); }

    const sessionFlow   = sg.deepCopy(sessionFlows[sessionId]);
    var   body          = {sessionId};

    uploadTimer         = null;
    delete sessionFlows[sessionId];

    if (sessionFlow) {
      body.payload = sessionFlow;

      verbose(3, `Uploading sessionFlow ${sessionId}, length: ${sessionFlow.length}`);
      return serverassist.POST('sa_dbgtelemetry', '/upload/', /*query=*/ {}, body, function(err, result) {
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
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

if (sg.callMain(ARGV, __filename)) {
  udp2DbgTelemetry(ARGV.getParams({}), {}, function(){});
}
