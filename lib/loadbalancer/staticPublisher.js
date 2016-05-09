'use strict';

var co = require('co');
var util = require('util');

/**
 * StaticPublisher yields a set of static endpoints as produced by the passed factory.
 * @param  {Array.<string>} instances Typically host:port strings which can be converted into endpoints.
 * @param  {function*} factory   Converts instance strings into endpoints.
 * @param  {Object} logger
 * @return {Object}           A Publisher.
 */
function* staticPublisher(instances, factory, logger) {
  var endpoints = [];
  for (let instance of instances) {
    try {
      let e = yield* factory(instance);
      endpoints.push(e);
    } catch (err) {
      logger.log('instance', instance, 'err', err);
    }
  }
  if (endpoints.length === 0) {
    throw new Error('no endpoints');
  }
  while (true) {
    yield endpoints;
  }
}

module.exports.staticPublisher = staticPublisher;