'use strict';

/*  eslint-disable require-yield */

const _ = require('lodash');
const isGeneratorFn = require('is-generator').fn;
const path = require('path');
const protobuf = require('protobufjs');

/**
 * Topic handles listening and sending events to a specific topic.
 */
class Topic {
  /**
   * @param {string} topicName
   * @param {Logger} logger
   */
  constructor(topicName, logger, config) {
    this.event = {};
    this.name = topicName;
    this.$logger = logger;
    this.$config = config;

    const protoRoot = config.protoRoot || path.join(process.cwd(), 'protos');
    if (_.isNil(protoRoot) || _.size(protoRoot) === 0) {
      throw new Error('config value protoRoot is not set');
    }
    const protos = config.protos;
    if (_.isNil(protos) || _.size(protos) === 0) {
      throw new Error('config value protos is not set');
    }
  }

  /**
   * Listen to eventName events with listener.
   *
   * @param {string} eventName Identification name of the event.
   * @param {function} listener Event listener.
   */
  * on(eventName, listener) {
    if (_.isNil(this.event[eventName])) {
      this.event[eventName] = {
        listeners: [],
        messages: [],
      };
    }
    this.event[eventName].listeners.push(listener);
  }

  /**
   * Encode the given message object using protobufjs (pbjs).
   *
   * @param  {string} eventName
   * @param  {Object} msg
   * @param  {string} protoFilePath
   * @param  {string} messageObject
   * @return {Object} buffer
   */
  * encodeObject(eventName, msg, protoFilePath, messageObject) {
    const protoRoot = yield protobuf.load(protoFilePath).then((root) => {
      return root;
    }).catch((err) => {
      this.$logger.error('error creating protoRoot for pbjs');
      throw err;
    });
    const root = protoRoot;
    const MessageClass = root.lookup(messageObject);

    const convertedMessage = MessageClass.create(msg);

    const buffer = MessageClass.encode(convertedMessage).finish();
    return buffer;
  }

  /**
   * Send message to listeners listening to eventName events.
   *
   * @param {string} eventName Identification name of the event.
   * @param {object} message Event message which is send to all listeners.
   */
  * emit(eventName, message) {
    let e = this.event[eventName];
    if (_.isNil(e)) {
      e = this.event[eventName] = {
        listeners: [],
        messages: [],
      };
    }
    const currentOffset = e.messages.length;
    let messages = message;
    let bufferObj;
    if (!_.isArray(message)) {
      messages = [message];
    }
    e.message = _.concat(e.message, message);
    const listeners = e.listeners;
    const logger = this.$logger;
    const protoFilePath = this.$config.protoRoot + this.$config.protos;
    const messageObject = this.$config.messageObject;
    for (let i = 0; i < listeners.length; i += 1) {
      const listener = listeners[i];
      for (let j = 0; j < messages.length; j += 1) {
        const context = {
          offset: currentOffset + j,
          topic: this.name,
          logger,
        };

        const msg = messages[i];
        bufferObj = yield this.encodeObject(eventName, msg,
        protoFilePath, messageObject);

        if (isGeneratorFn(listener)) {
          yield listener(bufferObj, context);
        } else {
          listener(bufferObj, context);
        }
      }
    }
  }

  /**
   * Number of listener which are listening to eventName event.
   * @param {string} eventName Identification name of the event.
   * @return {number} Number of listeners.
   */
  * listenerCount(eventName) {
    const e = this.event[eventName];
    if (_.isNil(e)) {
      return 0;
    }
    return e.listeners.length;
  }

  /**
   * Is a listener listening to eventName event.
   * @param {string} eventName Identification name of the event.
   * @return {boolean} True if any listener is listening, otherwise false.
   */
  * hasListeners(eventName) {
    const e = this.event[eventName];
    if (_.isNil(e)) {
      return false;
    }
    return e.listeners > 0;
  }

  /**
   * Remove listener from eventName event.
   * @param {string} eventName Identification name of the event.
   * @param {function} listener Listener function.
   */
  * removeListener(eventName, listener) {
    const e = this.event[eventName];
    if (_.isNil(e)) {
      return;
    }
    const index = e.listeners.indexOf(listener);
    if (!index) {
      e.listeners.splice(index, 1);
    }
  }

  /**
   * Remove all listener listening to eventName event.
   * @param {string} eventName Identification name of the event.
   */
  * removeAllListeners(eventName) {
    _.unset(this.event, eventName);
  }
}

/**
 * Local is a events provider.
 * It uses in-process communication
 * and does not support sending events to other processes or hosts.
 */
class Local {
  constructor(config, logger) {
    this.$topics = {};
    this.$logger = logger;
    this.$config = config;
  }

  /**
   * Return topicName topic.
   * @param {string} topicName The identification name of the topic.
   * @return {Topic}
   */
  * topic(topicName) {
    if (this.$topics[topicName]) {
      return this.$topics[topicName];
    }
    this.$topics[topicName] = new Topic(topicName, this.$logger, this.$config);
    return this.$topics[topicName];
  }

  /**
   * Initialize the event provider.
   */
  * start() {
    if (_.isNil(this.$topics)) {
      this.$topics = {};
    }
  }

  /**
   * Stop the event provider and all event communication.
   */
  * end() {
    _.forIn(this.$topics, function* endTopics(topic, key) {
      yield topic.removeAllListeners();
    });
  }
}

/**
 * Name of the event provider.
 */
module.exports.Name = 'local';

/**
 * Local events provider.
 * Provides in process event communication.
 */
module.exports.Local = Local;
