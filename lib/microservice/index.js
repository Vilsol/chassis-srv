'use strict';

let util = require('util');
let co = require('co');
let Events = require('../transport/events/events').Events;

var transports = {};

function registerTransport(name, provider) {
  transports[name] = provider;
}
module.exports.registerTransport = registerTransport;

var eventProviders = {};

function registerEventProvider(name, provider) {
  eventProviders[name] = provider;
}
module.exports.registerEventProvider = registerEventProvider;

// register providers
let Kafka = require('../transport/events/kafka').Kafka;
registerEventProvider('kafka', Kafka);
let Grpc = require('../transport/grpc').Server;
registerTransport('grpc', Grpc);

function setupEvents(config, logger) {
  if (!config.provider) {
    logger.log('ERROR', 'no event provider configured');
    return;
  }
  let name = config.provider.name;
  let EventProvider = eventProviders[name];
  if (!EventProvider) {
    logger.log('ERROR', 'event provider not registered', name);
    return;
  }
  logger.log('INFO', 'using event provider', name);
  let providerConfig = config.provider.config;
  let provider = new EventProvider(providerConfig, logger);
  return new Events(provider);
}

function setupTransport(config, logger) {
  let transport = {};
  logger.log('DEBUG', 'setupTransport', config);
  logger.log('DEBUG', 'transport providers', transports);
  for(let i in config) {
    let transportCfg = config[i];
    let name = transportCfg.name;
    let TransportProvider = transports[name];
    if (!TransportProvider) {
      logger.log('ERROR', 'transport not registered', name);
      return;
    }
    logger.log('INFO', 'using transport', name);
    let provider = new TransportProvider(transportCfg.config);
    transport[name] = provider;
  }
  return transport;
}

function Server(config) {
  var self =  this;
  this._config = config;

  // logger
  // TODO Load logger
  let logger = {
    log: console.log,
  };
  this.logger = logger;

  // events
  logger.log('DEBUG', 'setting up events');
  if (config.events) {
    this.events = setupEvents(config.events, self.logger);
  }

  // endpoints
  logger.log('DEBUG', 'setting up endpoints');
  if (!config.endpoints) {
    if (config.transports && config.transports.length > 0) {
      self.logger.log('WARNING', 'transports configured but no endpoints configured, disabling transports');
    }
    return;
  }

  // transports
  logger.log('DEBUG', 'setting up transports');
  if (config.transports){
    this.transport = setupTransport(config.transports, self.logger);
  }

  // signals
  // TODO React to more signals
  // TODO Make it configurable
  // listen to SIGINT signals
  process.on('SIGINT', function() {
    self.logger.log('INFO', 'signal', 'SIGINT');
    co(function*(){
      if (self.events) {
        // shutdown event provider
        yield self.events.provider.end();
      }
      if (self.transport) {
        let transportNames = Object.keys(self.transport);
        for(let i = 0; i < transportNames.length; i++) {
          let name = transportNames[i];
          if (self.transport[name].end) {
            yield self.transport[name].end();
          }
        }
      }
      process.exit(0);
    }).catch(function(err){
      self.logger.log('ERROR', err);
      process.exit(1);
    });
  });
}

// Server.prototype.middleware = []; TODO Implement middleware

Server.prototype.bind = function*(service) {
  let self = this;

  // endpoints
  self.logger.log('DEBUG', 'sorting endpoints and transports');
  let endpoints = {};
  Object.keys(self._config.endpoints).forEach(function(name){
    let endpoint = self._config.endpoints[name];
    self.logger.log('DEBUG', 'endpoint ' + name, endpoint);
    for(let i = 0; i < endpoint.transport.length; i++) {
      let transportName = endpoint.transport[i];
      if (!endpoints[transportName]) {
        endpoints[transportName] = [];
      }
      endpoints[transportName].push(name);
    }
  });
  self.logger.log('DEBUG', 'endpoints', endpoints);

  // transport
  if (!self.transport) {
    return;
  }
  self.logger.log('DEBUG', 'binding endpoints to transports');
  let props = Object.keys(self.transport);
  for(let i = 0; i < props.length; i++) {
    let transportName = props[i];
    let provider = self.transport[transportName];
    let methodNames = endpoints[transportName];
    if (!methodNames) {
      self.logger.log('WARNING', util.format('configured transport %s does not have any endpoints configured, binding empty service', transportName));
      yield provider.bind({});
      continue
    }
    let binding = {};
    for(let j = 0; j < methodNames.length; j++) {
      let name = methodNames[j];
      if (!(typeof(service[name]) == 'function')) {
        self.logger.log('WARNING', util.format('configured endpoint %s does not have matching service method', name));
        continue
      }
      // TODO Inject middlewares
      binding[name] = service[name];
      self.logger.log('DEBUG', util.format('endpoint %s bound to transport %s', transportName, name));
    }
    yield provider.bind(binding);
  };
}

Server.prototype.start = function*() {
  let self = this;

  // events
  yield this.events.provider.start();

  // transport
  if (!self.transport) {
    return;
  }
  let transportNames = Object.keys(self.transport);
  for(let i in transportNames) {
    let name = transportNames[i];
    let provider = self.transport[name];
    yield provider.start();
  };
}

module.exports.Server = Server;

/*

// server example
let server = new Server(config.server);
let service = new Service(server.events);
yield server.bind(service);
server.middleware.push(new Logging()); // Logging is custom middleware
server.endpoints.register.middleware.push(new LogTime()); // custom middleware
yield server.start();

// config
{
  "server": {
    "events": {
      "provider": {
          "name" : "kafka",
          "config": {
            "groupId": "restore-chassis-example-server",
            "clientId": "restore-chassis-example-server",
            "connectionString": "localhost:9092"
          }
      }
    },
    "endpoints": {
      "get": {
        transport: ["grpc"]
      },
      "register": {
        transport: ["grpc"]
      }
    },
    transports: [
      {
        "name": "grpc",
        "config": {
          "proto": "/../protos/user.proto",
          "package": "user",
          "service": "User",
          "addr": "localhost:50051"
        }
      }
    ]
  },
  "client": {
    "endpoints": {
      "get":{
        "publisher": {
          "name": "static",
          "instances": ["localhost:50051"]
        },
        "loadbalancer": [
          {
            "name": "roundRobin"
          }
        ],
        "middleware": [
          {
            "name": "retry",
            "max": 10,
            "timeout": 3000
          }
        ]
      },
      "register":{
        "publisher": {
          "name": "static",
          "instances": ["localhost:50051"]
        },
        "loadbalancer": [
          {
            "name": "random",
            "seed": 1
          }
        ],
        "middleware": [
          {
            "name": "retry",
            "max": 10,
            "timeout": 3000
          }
        ]
      },
    }
  }
}
*/