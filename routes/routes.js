
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
const AWS                 = require('aws-sdk');

const setOnn              = sg.setOnn;
const verbose             = sg.verbose;
const inspect             = sg.inspectFlat;

var lib = {};

lib.addRoutes = function(db, addHandler, callback) {
  var handlers    = {}, watchers = {}, data = {};
  var uploads     = {};
  var itemsForS3  = {};

  var attrMan = db.collection('attributeMan');

  const s3 = new AWS.S3();

  /**
   *  /upload handler
   */
  addHandler('/upload/*', handlers.upload = function(req, res, params, splats, query) {
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
      var params = {
        Body:         JSON.stringify(sessionItems),
        Bucket:       'sa-telemetry-netlab-asis',
        Key:          sessionId,
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
    console.log(inspect({sessionId, result}));

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


//    const uploadPart = function(PartNumber, UploadId, callback) {
//      const params = {
//        PartNumber,
//        UploadId,
//        Body:   origAll,
//        Bucket: 'sa-telemetry-netlab',
//        Key:    sessionId
//      };
//
//      return s3.uploadPart(params, (err, data) => {
//        console.log('sent', err, data);
//        if (sg.ok(err, data)) {
//          uploads[sessionId].etags[PartNumber] = data.ETag;
//        }
//        return callback(err, data);
//      });
//    };
//
//    const waitForCloseout = function(UploadId) {
//      const wait2 = function() {
//        console.log('Still waiting for closeout', _.now() - uploads[sessionId].finishTime);
//        if (_.now() < uploads[sessionId].finishTime) { return sg.setTimeout(3000, wait2); }
//
//        // Close it
//        const params = {
//          Bucket: 'sa-telemetry-netlab',
//          Key:    sessionId,
//          UploadId,
//          MultipartUpload: { Parts: _.map(uploads[sessionId].etags, (etag, index) => {
//            return {ETag: etag, PartNumber: index};
//          })}
//        };
//
//        params.MultipartUpload.Parts.shift();
//
//        console.log('comp:', sg.inspect(params));
//        return s3.completeMultipartUpload(params, (err, data) => {
//          console.log('complete', err, data);
//        });
//      };
//      wait2();
//    };
//
//    const uploadToS3 = function() {
//      if (!uploads[sessionId]) {
//        uploads[sessionId] = {sessionId, finishTime:_.now()+12000, partNum:1, etags:['xyz']};
//
//        // I have to create the multipart upload
//        const params = {Bucket: 'sa-telemetry-netlab', Key: sessionId};
//        return s3.createMultipartUpload(params, (err, data) => {
//          if (!sg.ok(err, data)) {
//            uploads[sessionId].dead = true;
//            return;
//          }
//
//          /* otherwise */
//          console.log(`created: ${data.UploadId}, ${data.Bucket}, ${data.Key}`);
//          uploads[sessionId].uploadId = data.UploadId;
//
//          // Now, actually upload the data
//          return uploadPart(1, data.UploadId, (err) => {
//            return waitForCloseout(data.UploadId);
//          });
//        });
//      }
//
//      if (uploads[sessionId].dead) { return; }
//      const myPartNum = ++uploads[sessionId].partNum;
//
//      const upload2 = function() {
//        if (!uploads[sessionId].uploadId) {
//          // The AWS multipart upload is not yet created, wait for it
//          console.log('-- still waiting for create');
//          return sg.setTimeout(1000, upload2);
//        }
//
//        // We have created the upload object, fire away
//        return uploadPart(myPartNum, uploads[sessionId].uploadId, (err) => {
//          console.log(err);
//        });
//      };
//      upload2();
//    };
//    uploadToS3();

