
/**
 *
 */
const sg                      = require('sgsg');
const _                       = sg._;
const request                 = sg.extlibs.superagent;
const urlLib                  = require('url');

const normlz                  = sg.normlz;

var prefix;

var lib = {};

lib.setPrefix = function(prefix_) {
  prefix = prefix_;
  console.log(`Using ${prefix} as upstream prefix.`);
};

lib.fetch = function(path, body, callback) {
  const url     = normlz(`${prefix}/${path}`);
  const urlObj  = urlLib.parse(url, true);

  // Must use curl to traverse proxy
  if (!urlObj.host.match(/([a-z0-9]+[.])?local/i) && process.env.http_proxy) {
    return sg.exec('curl', ['-s', url, '-d', JSON.stringify(body)], function(error, exitCode, stdoutChunks, stderrChunks, signal) {
      const stderr = stderrChunks && stderrChunks.join('');
      if (stderr.length > 0) {
        console.error(stderr);
      }

      if (error)              { return sg.die(error, callback, 'fetch.curl'); }
      if (exitCode !== 0)     { return sg.die(`NONZEROEXIT:${exitCode}`, callback, 'fetch.curl'); }
      if (signal)             { return sg.die(`SIG${signal}`, callback, 'fetch.curl'); }

      return callback(null, stdoutChunks.join(''));
    });
  } else {
    return request.post(url)
        .send(body).accept('json')
        .end(function(err, res) {
          if (err)      { return callback(err); }
          if (!res.ok)  { return callback(res.statusCode); }

          return callback(null, res.body);
        });
  }
};

_.each(lib, (value, key) => {
  exports[key] = value;
});

