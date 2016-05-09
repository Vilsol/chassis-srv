'use strict';

let attempt = require('retry');
let wait = require('wait.for-es6');
let co = require('co');

/**
 * retry wraps the load balancer to make it behave like a simple endpoint.
 * @param  {number} max          The maximum amount of retries.
 * @param  {number} timeout      The time in millisecond until the attempt times out.
 * @param  {function*} loadbalancer The endpoint provider.
 * @return {function*}              An endpoint.
 */
function retry(max, timeout, loadbalancer) {
  // TODO timeout operation attempt with timeout
  return function*(request) {
    function run(callback) {
      let errors = [];
      let operation = attempt.operation({
        retries: max,
        minTimeout: 0,
        maxTimeout: 10,
        unref: false
      });
      operation.attempt(function(currentAttempt) {
        let endpoint = loadbalancer.next();
        if (!endpoint.value) {
          let err = new Error('no endpoints');
          if (operation.retry(err)) {
            return;
          }
          callback(err ? operation.mainError() : null, null);
          return;
        }
        co(function*(){
          let result = yield endpoint.value(request);
          callback(operation.mainError(), result);
        }).catch(function(err){
          if (operation.retry(err)) {
            return;
          }
          callback(err ? operation.mainError() : null, null);
        });
      });
    }
    let resp = (yield wait.for(run))[0];
    return resp;
  };
}

module.exports.retry = retry;