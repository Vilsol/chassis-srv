'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/*  eslint-disable no-continue */
const chainMiddleware = require('./endpoint').chain;
const Logger = require('../logger').Logger;
const _ = require("lodash");
const events_1 = require("events");
const transports = {};
/**
 * register transport provider
 *
 * @param  {string} name     transport provider identifier
 * @param  {constructor} provider transport provider constructor function
 */
function registerTransport(name, provider) {
    transports[name] = provider;
}
exports.registerTransport = registerTransport;
// module.exports.registerTransport = registerTransport;
// register included providers
const grpc = require('./transport/provider/grpc');
registerTransport('grpc', grpc.Server);
const pipe = require('./transport/provider/pipe');
registerTransport(pipe.Name, pipe.Server);
/**
 * initializes all configured transports
 * @param  {object} config Configuration
 * @param  {object} logger
 * @return {object} Transport
 */
function setupTransport(config, logger) {
    const transport = {};
    logger.debug('available transport providers', Object.keys(transports).join(','));
    for (let i = 0; i < config.length; i += 1) {
        const transportCfg = config[i];
        const providerName = transportCfg.provider;
        if (_.isNil(providerName)) {
            throw new Error('transport configuration without a provider');
        }
        const transportName = transportCfg.name;
        if (_.isNil(providerName)) {
            throw new Error('transport configuration without a name');
        }
        const TransportProvider = transports[providerName];
        if (_.isNil(TransportProvider)) {
            throw new Error(`transport provider ${providerName} does not exist`);
        }
        const provider = new TransportProvider(transportCfg, logger);
        transport[transportName] = provider;
    }
    logger.debug('using transports', Object.keys(transport).join(','));
    return transport;
}
// calls middleware and business logic
function makeEndpoint(middleware, service, transportName, methodName, logger) {
    return function* callEndpoint(request, context) {
        const ctx = context || {};
        ctx.transport = transportName;
        ctx.method = methodName;
        ctx.logger = logger;
        let e;
        if (middleware.length > 0) {
            const chain = chainMiddleware(middleware);
            e = yield chain(service[methodName].bind(service));
        }
        else {
            e = service[methodName].bind(service);
        }
        try {
            logger.verbose(`received request to method ${ctx.method} over transport ${ctx.transport}`, request);
            const result = yield e(request, ctx);
            logger.verbose(`request to method ${ctx.method} over transport ${ctx.transport} result`, request, result);
            return result;
        }
        catch (err) {
            if (err instanceof SyntaxError || err instanceof RangeError ||
                err instanceof ReferenceError || err instanceof TypeError) {
                logger.error(`request to method ${ctx.method} over transport ${ctx.transport} error`, request, err.stack);
            }
            else {
                logger.info(`request to method ${ctx.method} over transport ${ctx.transport} error`, request, err);
            }
            throw err;
        }
    };
}
/**
 * Server is a microservice server chassis.
 * It enables business logic to be accessed over transports and listen to events.
 * Default event providers: 'kafka'
 * Default transports: 'grpc'
 * @class
 */
class Server extends events_1.EventEmitter {
    /**
     * @constructor
     * @param {object} config Server config.
     * @param {Logger} logger
     */
    constructor(config, logger) {
        super();
        if (_.isNil(config)) {
            throw new Error('mising argument config');
        }
        this.config = config;
        // logger
        if (_.isNil(logger)) {
            if (_.isNil(this.config.logger)) {
                this.logger = new Logger();
            }
            else {
                this.logger = new Logger(this.config.logger);
            }
        }
        else {
            this.logger = logger;
        }
        // services
        this.logger.debug('setting up service endpoints');
        if (!this.config.services || !this.config.transports) {
            if (this.config.events) {
                if (this.config.transports) {
                    this.logger.warn('missing endpoints configuration');
                }
                if (this.config.services) {
                    this.logger.warn('missing services configuration');
                }
                return;
            }
            if (this.config.transports && this.config.transports.length > 0) {
                throw new Error('missing services configuration');
            }
            if (this.config.services) {
                throw new Error('missing transports configuration');
            }
            throw new Error('missing server configuration');
        }
        // transports
        this.logger.debug('setting up transports');
        try {
            this.transport = setupTransport(this.config.transports, this.logger);
        }
        catch (error) {
            this.logger.error('setupTransports', error);
            throw error;
        }
        /**
         * Requests will traverse the middlewares in the order they're declared.
         * That is, the first middleware is called first.
         *
         * @type {Array.<generator>}
         */
        this.middleware = [];
    }
    /**
     * bind connects the service to configured transports.
     *
     * @param  {string} name Service name.
     * @param  {object} service A business logic service.
     */
    *bind(name, service) {
        if (_.isNil(name)) {
            throw new Error('missing argument name');
        }
        if (!_.isString(name)) {
            throw new Error('argument name is not of type string');
        }
        if (_.isNil(service)) {
            throw new Error('missing argument service');
        }
        const serviceCfg = this.config.services[name];
        if (!serviceCfg) {
            throw new Error(`configuration for ${name} does not exist`);
        }
        const transportNames = Object.keys(this.transport);
        // endpoints
        const logger = this.logger;
        const endpoints = {};
        Object.keys(serviceCfg).forEach((endpointName) => {
            const endpointCfg = serviceCfg[endpointName];
            if (_.isNil(endpointCfg)) {
                logger.error(`configuration for service
        ${name} endpoint ${endpointName} does not exist`);
                return;
            }
            for (let i = 0; i < endpointCfg.transport.length; i += 1) {
                const transportName = endpointCfg.transport[i];
                if (!endpoints[transportName]) {
                    endpoints[transportName] = [];
                }
                if (!_.includes(transportNames, transportName)) {
                    logger.warn(`transport ${transportName} does not exist`, {
                        service: name,
                        method: endpointName,
                    });
                    continue;
                }
                endpoints[transportName].push(endpointName);
            }
        });
        logger.debug('endpoints', endpoints);
        logger.debug('binding endpoints to transports');
        const middleware = this.middleware;
        const transport = this.transport;
        for (let i = 0; i < transportNames.length; i += 1) {
            const transportName = transportNames[i];
            const provider = transport[transportName];
            const methodNames = endpoints[transportName];
            if (!methodNames) {
                logger.verbose(`transport ${transportName} does not have any endpoints configured`);
                continue;
            }
            const binding = {};
            for (let j = 0; j < methodNames.length; j += 1) {
                const methodName = methodNames[j];
                if (!_.isFunction(service[methodName])) {
                    logger.warn(`endpoint ${methodName} does not have matching service method`);
                    continue;
                }
                const methodCfg = serviceCfg[methodName];
                if (_.isNil(methodCfg)) {
                    logger.error(`endpoint ${name}.${methodName} does not have configuration`);
                    continue;
                }
                if (!_.includes(methodCfg.transport, transportName)) {
                    logger.error(`endpoint ${name}.${methodName}
        is not configured for transport ${transportName}, skipping endpoint binding`);
                    continue;
                }
                binding[methodName] = makeEndpoint(middleware, service, transportName, methodName, logger);
                logger.debug(`endpoint ${methodName} bound to transport ${transportName}`);
            }
            if (_.size(_.functions(binding)) === 0) {
                logger.verbose(`service ${name} has no endpoints configured
      for transport ${transportName}, skipping service binding`);
                continue;
            }
            yield provider.bind(name, binding);
            this.emit('bound', name, binding, provider);
        }
    }
    /**
     * start launches the server by starting transports and listening to events.
     */
    *start() {
        const transportNames = Object.keys(this.transport);
        for (let i = 0; i < transportNames.length; i += 1) {
            const name = transportNames[i];
            const provider = this.transport[name];
            yield provider.start();
            this.logger.info(`transport ${name} started`);
        }
        this.emit('serving', this.transport);
    }
    /**
     * Shutsdown all transport provider servers.
     */
    *end() {
        const transportNames = Object.keys(this.transport);
        for (let i = 0; i < transportNames.length; i += 1) {
            const name = transportNames[i];
            if (this.transport[name].end) {
                yield this.transport[name].end();
            }
        }
        this.emit('stopped', this.transport);
    }
}
exports.Server = Server;