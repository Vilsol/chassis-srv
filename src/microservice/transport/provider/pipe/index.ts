'use strict';

import * as _ from "lodash";
const errors = require('../../../errors');
/*  eslint-disable require-yield */

/**
 * Name of the transport
 *
 * @const
 */
const NAME = 'pipe';

const servers = {};

/**
 * Server transport provider.
 * The pipe server uses in-process communication and can not communication with other
 * processes or hosts.
 * @class
 */
export class Server {
  name: string;
  config: any;
  logger: any;
  service: any;
  addr: any;

  /**
   * Create a pipe server.
   * @constructor
   * @param {object} config Pipe server config.
   * @logger {Logger} logger
   */
  constructor(config: any, logger: any) {
    this.name = NAME;
    this.config = config;
    this.logger = logger;
    this.service = {};
    this.addr = config.addr;
  }

  /**
   * Bind the named service.
   * @param {string} name Identification name of the service.
   * @param {object} service Business logic service.
   * Each method is mapped according to the configuration.
   */
  * bind(name: string, service: Object): any {
    // this.stupid = 'stupid';
    const logger = this.logger;
    if (_.isNil(name)) {
      throw new Error('missing argument name');
    }
    if (!_.isString(name)) {
      throw new Error('argument name is not of type string');
    }
    if (_.isNil(service)) {
      throw new Error('missing argument service');
    }
    this.service[name] = service;
    logger.verbose(`service ${name} bound to transport ${this.name}`, _.functions(service));
  }

  /**
   * Publish the server on the internal server list.
   */
  * start(): any {
    if (!_.isNil(servers[this.addr])) {
      throw new Error(`address ${this.addr} in use`);
    }
    _.set(servers, this.addr, this);
    this.logger.verbose(`transport ${this.name} is serving`);
  }

  /**
   * Remove the server from the internal server list.
   */
  * end(): any {
    _.unset(servers, this.addr);
  }
}

/**
 * Client transport provider.
 * Connects to pipe servers over a internal list.
 * @class
 */
export class Client {

  config: any;
  logger: any;
  name: string;
  state: any;
  connected: boolean;

  /**
   * Create a pipe client.
   * @constructor
   * @param {object} config Pipe client config.
   * @logger {Logger} logger
   */
  constructor(config: any, logger: any) {
    // check config
    if (!_.has(config, 'service')) {
      throw new Error('client is missing service config field');
    }

    this.name = NAME;
    this.config = config;
    this.logger = logger;
    this.state = {
      connected: true,
    };
  }

  /**
   * Create endpoint from instance and method name.
   * @param {string} methodName Name of the business logic service method.
   * @param {string} instance Identifier which is used to find a server.
   * @return {generator} Returns the endpoint.
   */
  * makeEndpoint(methodName: string, instance: string): any {
    const logger = this.logger;
    logger.debug('pipe.makeEndpoint', methodName, instance);
    const server = _.get(servers, instance);
    if (_.isNil(server)) {
      throw new Error(`server with ${instance} address does not exist`);
    }
    const service = server.service[this.config.service];
    if (_.isNil(service)) {
      throw new Error(`server does not have service ${this.config.service}`);
    }
    const method = service[methodName];
    const state = this.state;
    const serviceName = this.config.service;
    return function* pipe(request: any, context: any): any {
      if (_.isNil(method)) {
        return {
          error: new Error('unimplemented'),
        };
      }

      if (!state.connected) {
        return {
          error: new Error('unreachable'),
        };
      }
      const serverContext = {
        transport: 'pipe',
        logger,
      };
      const call = {
        request: request || {},
      };
      try {
        const response = yield method(call, serverContext);
        logger.debug(`response from ${serviceName}.${methodName}`, response);
        return {
          data: response,
        };
      } catch (error) {
        let err;
        _.forEach(errors, (Error) => {
          if (error.constructor.name === Error.name) {
            err = new Error(error.details);
          }
        });
        if (_.isNil(err)) {
          err = new errors.Internal(error.message);
        }
        return {
          error: err,
        };
      }
    };
  }

  /**
   * Set client to be disconnected.
   */
  * end(): any {
    this.connected = false;
  }
}

module.exports.Name = NAME;
// module.exports.Server = Server;
// module.exports.Client = Client;
