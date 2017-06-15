
/**
 *  Listen on UDP --port for JSON; send the JSON to a dbg-telemetry web service.
 *
 *  There is one dgram socket listener, which will receive one JSON telemetry object
 *  per recv, and parse it. It then sends the JSON to a `send` function. The send
 *  function queues the JSON, and uploads it to the dbg-telemetry service every
 *  so often.
 */
const sg                = require('sgsg');
const _                 = sg._;
const dgram             = require('dgram');
const request           = sg.extlibs.superagent;

const ARGV              = sg.ARGV();
const normlz            = sg.normlz;
const argvGet           = sg.argvGet;
const verbose           = sg.verbose;

var lib = {};

lib.udp2DbgTelemetry = function(argv, context, callback) {
  const telemFqdn     = argvGet(argv, 'fqdn')                 || 'local.mobilewebassist.net';
  const telemVer      = argvGet(argv, 'version,v')            || 'v1';
  const telemRoute    = argvGet(argv, 'route')                || normlz(`/xcc/api/${telemVer}/dbg-telemetry/upload/`);
  const telemEndpoint = argvGet(argv, 'endpoint')             || normlz(`http://${telemFqdn}/${telemRoute}`);
  const udpPort       = argvGet(argv, 'udp-port,port')        || 50505;
  const upTimeout     = argvGet(argv, 'upload-timeout,to')    || 1000;
  const upMaxCount    = argvGet(argv, 'upload-max,max')       || 5;
  const defSessionId  = argvGet(argv, 'session-id')           || 'session_'+_.now()

  var   sendPayload;
  var   sessions = {};

  // ---------- Listen on UDP and upload incoming -----------
  const server = dgram.createSocket('udp4');

  server.on('message', (msg_, rinfo) => {
    var msg = msg_.toString();

    verbose(3, `UDP Message from ${rinfo.address}:${rinfo.port}: |${msg}|`);
    msg = msg.replace(/[\n\t ]+$/g, '');

    const m = /^(\S+)\s+(.*)$/.exec(msg);
    if (m) {
      var payload = sg.safeJSONParse(m[2], {});
      verbose(3, `From ${rinfo.address}:${rinfo.port}`, payload);
      if (payload) {
        sendPayload({payload});
      }
    } else {
      console.error('no m');
    }
  });

  server.on('listening', () => {
    const address = server.address();
    console.log(`UDP server listening on ${address.address}:${address.port}`);
  });

  server.on('error', (err) => {
    console.error(`UDP server error: ${err.stack}`);
    server.close();
  });

  server.bind(udpPort, '127.0.0.1');

  // ---------- Upload ----------
  var uploadTimer, uploadSession;

  sendPayload = function(body, callback_) {
    var callback = callback_ || function(){};

    verbose(2, body);

    if (!body || !body.payload) { return callback(sg.toError('ENOPAYLOAD')); }

    const payload   = sg.extract(body, 'payload');
    const sessionId = sg.extract(body, 'sessionId') || defSessionId;

    var session = sessions[sessionId] = sessions[sessionId] || [];

    // Push the data into an array to be uploaded
    session.push(payload);

    verbose(2, `${session.length} items in ${sessionId}`, payload);
    if (session.length >= upMaxCount) {
      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
      }

      return uploadSession(sessionId, callback);
    }

    // Let data accumulate for a while
    if (!uploadTimer) {
      uploadTimer = setTimeout(() => {
        uploadTimer = null;
        uploadSession(sessionId, callback);
      }, upTimeout);
    }
  };

  uploadSession = function(sessionId, callback_) {
console.error(`uploadSession: ${sessionId}`);
    const callback  = callback_ || function(){};
    const session   = sessions[sessionId];
    const endpoint  = normlz(`${telemEndpoint}`);
    var   body      = {sessionId};

    uploadTimer     = null;
    delete sessions[sessionId];

    if (session) {
      body.payload = session;

      console.log(`Uploading session, length: ${session.length}, endpoint: ${endpoint}`);
      request.post(endpoint)
          .send(body).accept('json')
          .end(callback);
    }
  };
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

if (sg.callMain(ARGV, __filename)) {
  lib.udp2DbgTelemetry({}, {}, function(){});
}


