'use strict';

/* eslint import/no-extraneous-dependencies: ["error", {"devDependencies": true}] */
const mocha = require('mocha');
const coMocha = require('co-mocha');
coMocha(mocha);

const should = require('should');
const _ = require('lodash');
const sync = require('gostd').sync;
const logger = require('./logger_test.js');
const chassis = require('../');
const config = chassis.config;
const Events = chassis.events.Events;

/* global describe it before after */

describe('Kafka events provider', () => {
  let events;
  before(function* setupProvider() {
    config.load(process.cwd() + '/test', logger);
    events = new Events('kafkaTest');
    yield events.start();
  });
  after(function* stopProvider() {
    yield events.end();
  });
  describe('topic.on', function topicOn() {
    this.timeout(5000);
    it('should receive the correct message', function* checkSendReceive() {
      const topic = yield events.topic('test.wait');
      const testMessage = {
        value: 'test',
        count: 1,
        kv: {},
      };
      const wg = new sync.WaitGroup();
      let err;
      yield topic.on('test-event', function* onTestEvent(message, context) {
        try {
          should.exist(message);
          should.exist(message.kv);
          const keys = _.keys(message.kv);
          keys.should.equal([]);
        } catch (error) {
          err = error;
        }
        wg.done();
      });
      wg.add(1);
      yield topic.emit('test-event', testMessage);
      yield wg.wait();
      should.ifError(err);
    });
  });
  describe('topic.$wait', function testWait() {
    this.timeout(5000);
    it('should wait until the event message is processed', function* waitUntil() {
      const testMessage = {
        value: 'test',
        count: 1,
      };
      const topic = yield events.topic('test.wait');
      let receivedOffset = yield topic.$offset(-1);
      yield topic.on('test-event', function* onTestEvent(message, context) {
        should.exist(message);
        receivedOffset = context.offset;
      });
      const offset = yield topic.$offset(-1);
      yield topic.emit('test-event', testMessage);
      yield topic.$wait(offset);
      offset.should.equal(receivedOffset);
    });
  });
});
