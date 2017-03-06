'use strict';

/* eslint import/no-extraneous-dependencies: ["error", {"devDependencies": true}] */
/*  eslint-disable require-yield */

import * as mocha from 'mocha';
import * as coMocha from 'co-mocha';

coMocha(mocha);

import * as should from 'should';
import * as co from 'co';
const _ = require('lodash');
const sync = require('gostd').sync;
const isGeneratorFn = require('is-generator').fn;
const logger = require('./logger_test.js');
import * as chassis from '../lib';

import * as root1 from '../definitions/bundled';
const config = chassis.config;
const Events = chassis.Events;


/* global describe it before after */

describe('events', () => {
  describe('without a provider', () => {
    const topicName = 'test';
    describe('yielding subscribe', () => {
      it('should throw an error', function* checkGetTopic() {
        const result = yield co(function* getTopic() {
          const events: chassis.Events = new Events();
          return yield events.topic(topicName);
        }).then((res) => {
          should.ok(false, 'should not call then');
        }).catch((err) => {
          should.exist(err);
          err.should.be.Error();
          err.message.should.equal('missing argument config');
        });
        should.not.exist(result);
      });
    });
  });
  const providers = ['kafkaTest', 'localTest'];
  _.forEach(providers, (eventsName: string) => {
    describe(`testing config ${eventsName}`, () => {
      let events: chassis.Events;
      const topicName = 'test';
      let topic: chassis.Topic;
      const eventName = 'test-event';

      const testMessage = { value: 'testValue', count: 1 };

      before(function* start() {
        this.timeout(10000);
        yield config.load(process.cwd() + '/test', logger);
        const cfg = yield config.get();
        events = new Events(cfg.get(`events:${eventsName}`), logger);
        yield events.start();
      });
      after(function* start() {
        yield events.end();
        events = null;
      });
      describe('yielding subscribe', () => {
        it('should return a topic', function* checkGetTopic() {
          topic = yield events.topic(topicName);
          should.exist(topic);
          should.exist(topic.on);
          should.exist(topic.emit);
          should.exist(topic.listenerCount);
          should.exist(topic.hasListeners);
          should.exist(topic.removeListener);
          should.exist(topic.removeAllListeners);
          should.ok(isGeneratorFn(topic.on));
          should.ok(isGeneratorFn(topic.emit));
          should.ok(isGeneratorFn(topic.listenerCount));
          should.ok(isGeneratorFn(topic.hasListeners));
          should.ok(isGeneratorFn(topic.removeListener));
          should.ok(isGeneratorFn(topic.removeAllListeners));
        });
      });
      describe('yielding Provider.start', function startKafka() {
        this.timeout(5000);
        it('should allow listening to events', function* listenToEvents() {
          const listener = function* listener() {
            // void listener
          };
          const count: number = yield topic.listenerCount(eventName);
          yield topic.on(eventName, listener);
          const countAfter = yield topic.listenerCount(eventName);
          countAfter.should.equal(count + 1);
        });
        it('should allow removing all listeners', function* removeAllListeners() {
          const listener = function* listener() {
            // void listener
          };
          yield topic.on(eventName, listener);
          yield topic.removeAllListeners(eventName);
          const count: number = yield topic.listenerCount(eventName);
          count.should.equal(0);
        });
        it('should allow removing a listener', function* removeListener() {
          const listener = function* listener() {
            // void listener
          };
          const count: number = yield topic.listenerCount(eventName);
          yield topic.on(eventName, listener);
          yield topic.removeListener(eventName, listener);
          const countAfter = yield topic.listenerCount(eventName);
          countAfter.should.equal(count);
        });
        it('should allow counting listeners', function* countListeners() {
          const listener = function* listener() {
            // void listener
          };
          const count: number = yield topic.listenerCount(eventName);
          should.exist(count);
          const hasListeners = yield topic.hasListeners(eventName);
          hasListeners.should.equal(count > 0);
          yield topic.on(eventName, listener);
          let countAfter = yield topic.listenerCount(eventName);
          countAfter.should.equal(count + 1);
          yield topic.removeListener(eventName, listener);
          countAfter = yield topic.listenerCount(eventName);
          countAfter.should.equal(count);
        });
        it('should allow emitting', function* sendEvents() {
          this.timeout(20000);
          const wg = new sync.WaitGroup();
          let buff = [];

          const listener = function* listener(message, context, config1, eventName1) {
            function* decodeAndCompareObjects() {
              const stringmessageObject = config1.messageObject;
              const root2 = root1.test.TestEvent;
              // const TestEvent = root.lookup('test.TestEvent');
              const buffer = root2.decode(message);
              // Auto completion for values here:
              buffer.count;
              buffer.value;
              testMessage.value.should.equal(buffer.value);
              testMessage.count.should.equal(buffer.count);
              return buffer;
            }

            yield decodeAndCompareObjects();
            wg.done();
          };
          wg.add(1);
          yield topic.on(eventName, listener);
          setImmediate(() => {
            co(function* emit() {
              yield topic.emit(eventName, testMessage);
            });
          });
          yield wg.wait();
        });
      });
    });
  });
});