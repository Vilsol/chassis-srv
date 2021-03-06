'use strict';
import * as _ from 'lodash';
import * as co from 'co';
import { Server } from './../microservice/server';
import * as errors from './../microservice/errors';
import * as database from './../database';
import * as Logger from '@restorecommerce/logger';
import { Events, Topic } from '@restorecommerce/kafka-client';

const ServingStatus = {
  UNKNOWN: 'UNKNOWN',
  SERVING: 'SERVING',
  NOT_SERVING: 'NOT_SERVING',
};

/**
 * Generic interface to expose system operations.
 */
export interface ICommandInterface {
  command(call, context);
}

/**
 * Base implementation.
 * Currently includes:
 * * 'check' - returns UNKNOWN, SERVING or NOT_SERVING
 * * 'version' - returns NPM service version and Node.js version
 * * 'reset' - truncated all DB instances specified in config files
 * * 'restore' - re-reads Kafka events to restore a set of ArangoDB collections' data
 *  Unimplemented:
 * * reconfigure
 *
 * In case of custom data/events handling or service-specific operations regarding
 * a certain method, such method should be extended or overriden.
 */
export class CommandInterface implements ICommandInterface {
  logger: Logger;
  config: any;
  health: any;
  service: any;
  kafkaEvents: Events;
  commands: any;
  commandTopic: Topic;
  constructor(server: Server, config: any, logger: Logger, events: Events) {
    if (_.isNil(events)) {
      if (logger.error) {
        logger.error('No Kafka client was provided. Disabling all commands.');
        return;
      }
    }
    if (!_.has(config, 'server.services')) {
      throw new Error('missing config server.services');
    }

    this.config = config;
    this.logger = logger;

    // disable reset and restore if there are no databases in configs
    if (!_.has(this.config, 'events')
      || !_.has(this.config.events, 'kafka'
        || !_.has(this.config.events.kafka, 'topics'))) {
      throw new Error('Missing events config on command interface.');
    }

    this.kafkaEvents = events;

    // Health
    this.health = {
      status: ServingStatus.UNKNOWN,
    };
    this.service = {};
    const service = this.service;
    const health = this.health;
    _.forEach(config.server.services, (serviceCfg, serviceName) => {
      service[serviceName] = {
        bound: false,
        transport: {},
      };
    });
    server.on('bound', (serviceName) => {
      service[serviceName].bound = true;
      health.status = ServingStatus.NOT_SERVING;
    });
    server.on('serving', (transports) => {
      health.status = ServingStatus.SERVING;
      _.forEach(transports, (transport, transportName) => {
        _.forEach(service, (srv, serviceName) => {
          service[serviceName].transport[transportName] = ServingStatus.SERVING;
        });
      });
    });
    server.on('stopped', (transports) => {
      health.status = ServingStatus.NOT_SERVING;
      _.forEach(transports, (transport, transportName) => {
        _.forEach(service, (srv, serviceName) => {
          service[serviceName].transport[transportName] = ServingStatus.NOT_SERVING;
        });
      });
    });

    // list of available commands
    this.commands = {
      reset: this.reset,
      restore: this.restore,
      reconfigure: this.reconfigure,
      health_check: this.check,
      version: this.version
    };
    const topicCfg = config.events.kafka.topics.commandinterface;
    this.commandTopic = events.topic(topicCfg.topic);
  }
  /**
   * Generic command operation, which demultiplexes a command by its name and parameters.
   * @param call
   * @param context
   */
  async command(call, context?: any): Promise<any> {
    if (_.isNil(call.request) && _.isNil(call.name)) {
      throw new errors.InvalidArgument('No command name provided');
    }
    const name = call.name || call.request.name;

    if (_.isNil(this.commands[name])) {
      throw new errors.InvalidArgument(`Command name ${name} does not exist`);
    }
    const payload = call.payload ? this.decodeMsg(call.payload) :
      (call.request.payload ? this.decodeMsg(call.request.payload) : null);
    // calling operation bound to the command name
    const result = await this.commands[name].apply(this, [payload]);

    return this.encodeMsg(result);
  }

  /**
   * Reconfigure service
   * @param call
   * @param context
   */
  reconfigure(): any {
    this.logger.info('reconfigure is not implemented');
    throw new errors.Unimplemented('reconfigure is not implemented');
  }

  /**
   * Restore the system by re-reading Kafka messages. Default implementation
   * restores collection documents from a set of ArangoDB databases, using
   * the chassis-srv database provider.
   * @param topics list of Kafka topics to be restored
   */
  async restore(payload: any): Promise<any> {
    if (_.isNil(payload) || _.keys(payload).length == 0) {
      throw new errors.InvalidArgument('Invalid payload for restore command');
    }


    // the Kafka config should contains a key-value pair, mapping
    // a label with the topic's name
    // in case of a resource topic, the label should be the resource name itself
    const kafkaCfg = this.config.events.kafka.topics;
    if (_.isNil(kafkaCfg) || kafkaCfg.length == 0) {
      throw new errors.Internal('Kafka topics config not available');
    }

    const topicLabels = _.keys(kafkaCfg.map).filter((elem, index) => {
      return elem.includes('.resource');
    }).map((elem) => {
      return elem.replace('.resource', '');
    });
    const events = {};

    try {
      const dbCfgs = this.config.database;
      const dbCfgNames = _.keys(dbCfgs);
      for (let i = 0; i < dbCfgNames.length; i += 1) {
        const dbCfgName = dbCfgNames[i];
        const dbCfg = dbCfgs[dbCfgName];
        const collections = dbCfg.collections;
        const db = await co(database.get(dbCfg, this.logger));

        if (_.isNil(collections)) {
          this.logger.warn('No collections found on DB config');
          return {};
        }

        for (let collection of collections) {
          if (topicLabels.indexOf(collection) > -1 && payload[collection]) {
            const topicName = kafkaCfg[collection].topic;
            events[topicName] = {
              topic: this.kafkaEvents.topic(topicName),
              events: this.makeResourcesRestoreSetup(db, collection),
              resource: collection
            };
          }
        }
      }

      const that = this;
      // Start the restore process
      this.logger.warn('restoring data');
      for (let topic in events) {
        const topicSetup: any = events[topic];
        const restoreTopic: Topic = topicSetup.topic;
        const topicEvents: any = topicSetup.events;
        const resource: string = topicSetup.resource;

        // const eventNames = _.keys(restoreTopic.events);
        const baseOffset: number = payload[resource].offset || 0;
        const targetOffset: number = (await restoreTopic.$offset(-1)) - 1;
        const ignoreOffsets: number[] = payload[resource].ignore_offset || [];
        const eventNames = _.keys(topicEvents);

        this.logger.debug(`topic ${topic} has current offset ${targetOffset}`);
        for (let eventName of eventNames) {
          const listener = topicEvents[eventName];
          const listenUntil = async function listenUntil(message: any, ctx: any,
            config: any, eventNameRet: string): Promise<any> {
            that.logger.debug(`received message ${ctx.offset}/${targetOffset}`, ctx);
            if (_.includes(ignoreOffsets, ctx.offset)) {
              return;
            }
            try {
              await listener(message, ctx, config, eventNameRet);
            } catch (e) {
              that.logger.debug('Exception caught :', e.message);
            }
            if (ctx.offset >= targetOffset) {
              const message = {};
              message['topic'] = topic;
              message['offset'] = ctx.offset;
              await that.commandTopic.emit('restoreResponse', {
                services: _.keys(that.service),
                payload: that.encodeMsg(message)
              });

              for (let name of eventNames) {
                that.logger.debug('Number of listeners before removing :',
                  restoreTopic.listenerCount(name));
                await restoreTopic.removeAllListeners(name);
                that.logger.debug('Number of listeners after removing :',
                  restoreTopic.listenerCount(name));
              }
              that.logger.info('restore process done');
            }
          };
          this.logger.debug(`listening to topic ${topic} event ${eventName}
            until offset ${targetOffset} while ignoring offset`, ignoreOffsets);
          await restoreTopic.on(eventName, listenUntil);
          this.logger.debug(`resetting commit offset of topic ${topic} to ${baseOffset}`);
          await restoreTopic.$reset(eventName, baseOffset);
          this.logger.debug(`reset done for topic ${topic} to commit offset ${baseOffset}`);
        }
      }
      this.logger.debug('waiting until all messages are processed');
    } catch (err) {
      this.logger.error('Error occurred while restoring the system', err.message);
      await this.commandTopic.emit('restoreCommand', {
        services: _.keys(this.service),
        payload: this.encodeMsg({
          error: err.message
        })
      });
    }

    return {};
  }

  /**
   * Reset system data related to a service. Default implementation truncates
   * a set of ArangoDB instances, using the chassis-srv database provider.
   */
  async reset(): Promise<any> {
    this.logger.info('reset process started');
    if (this.health.status !== ServingStatus.NOT_SERVING) {
      this.logger.warn('reset process starting while server is serving');
    }

    let errorMsg = null;
    try {
      const dbCfgs = this.config.database;
      const dbCfgNames = _.keys(dbCfgs);
      for (let i = 0; i < dbCfgNames.length; i += 1) {
        const dbCfgName = dbCfgNames[i];
        const dbCfg = dbCfgs[dbCfgName];
        const db = await co(database.get(dbCfg, this.logger));
        switch (dbCfg.provider) {
          case 'arango':
            await co(db.truncate());
            this.logger.info(`arangodb ${dbCfg.database} truncated`);
            break;
          default:
            this.logger.error(
              `unsupported database provider ${dbCfg.provider} in database config ${dbCfgName}`);
            break;
        }
      }
    } catch (err) {
      this.logger.error('Unexpected error while resetting the system', err.message);
      errorMsg = err.message;
    }

    const eventObject = {
      services: _.keys(this.service),
      payload: null
    };

    if (errorMsg) {
      eventObject.payload = this.encodeMsg({
        error: errorMsg
      });
    } else {
      eventObject.payload = this.encodeMsg({
        status: 'Reset concluded successfully'
      });
    }
    await this.commandTopic.emit('resetResponse', eventObject);

    this.logger.info('reset process ended');

    if (errorMsg) {
      return {
        error: errorMsg
      };
    }
    return {};
  }

  /**
   * Check the service status
   * @param call List of services to be checked
   * @param context
   */
  async check(payload: any): Promise<any> {
    if (_.isNil(payload)) {
      throw new errors.InvalidArgument('Invalid payload for restore command');
    }
    const serviceName = payload.service;

    if (_.isNil(serviceName) || _.size(serviceName) === 0) {
      await this.commandTopic.emit('healthCheckResponse', {
        services: _.keys(this.service),
        payload: this.encodeMsg({
          status: this.health.status,
        })
      });
      return {
        status: this.health.status,
      };
    }
    const service = this.service[serviceName];
    if (_.isNil(service)) {
      const errorMsg = 'Service ' + serviceName + ' does not exist';
      this.logger.warn(errorMsg);
      return {
        error: errorMsg
      };
    }
    let status = ServingStatus.UNKNOWN;
    // If one transports serves the service, set it to SERVING
    _.forEach(service.transport, (transportStatus) => {
      if (transportStatus === ServingStatus.SERVING) {
        status = transportStatus;
      }
    });
    await this.commandTopic.emit('healthCheckResponse', {
      services: [serviceName],
      payload: this.encodeMsg({
        status,
      })
    });
    return {
      status,
    };
  }

  /**
   * Retrieve current NPM package and Node version of service
   */
  async version(): Promise<any> {
    const response = {
      nodejs: process.version,
      version: process.env.npm_package_version,
    };
    await this.commandTopic.emit('versionResponse', {
      services: _.keys(this.service),
      payload: this.encodeMsg(response)
    });
    return response;
  }

  // Helper functions

  /**
   * Generic resource restore setup.
   * @param db
   * @param collectionName
   */
  makeResourcesRestoreSetup(db: any, collectionName: string): any {
    return {
      [`${collectionName}Created`]: async function restoreCreated(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.insert(`${collectionName}s`, message));
        return {};
      },
      [`${collectionName}Modified`]: async function restoreModified(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.update(collectionName, { id: message.id }, _.omitBy(message, _.isNil)));
        return {};
      },
      [`${collectionName}Deleted`]: async function restoreDeleted(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await co(db.delete(collectionName, { id: message.id }));
        return {};
      }
    };
  }

  /**
  *
  * @param msg google.protobuf.Any
  * @returns Arbitrary JSON
  */
  decodeMsg(msg: any): any {
    const decoded = Buffer.from(msg.value, 'base64').toString();
    return JSON.parse(decoded);
  }

  /**
   *
   * @param msg Arbitrary JSON
   * @returns google.protobuf.Any formatted message
   */
  encodeMsg(msg: any): any {

    const stringified = JSON.stringify(msg);
    const encoded = Buffer.from(stringified).toString('base64');
    const ret = {
      type_url: 'payload',
      value: encoded
    };
    return ret;
  }

}
