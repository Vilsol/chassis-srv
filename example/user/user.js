'use strict';

const co = require('co');
const Server = require('../../lib/microservice').Server;
const config = require('../../lib/config');

// Service the business logic of this microservice.
function Service(userEvents, logger) {
  this.data = [{
    id: '/users/admin',
    created: Date.now(),
  }, {
    id: '/users/me',
    created: Date.now(),
  }];

  // will be an endpoint
  this.register = function* register(request, context) {
    const guest = request.guest;
    let name = request.name;
    const email = request.email;
    const password = request.password;
    if (guest) {
      name = '';
    }
    if (!name) {
      const err = new Error('invalid argument');
      err.details = 'argument name is empty';
      throw err;
    }
    if (!email) {
      const err = new Error('invalid argument');
      err.details = 'argument email is empty';
      throw err;
    }
    if (!password) {
      const err = new Error('invalid argument');
      err.details = 'argument password is empty';
      throw err;
    }
    const user = {
      id: '/users/' + name,
      guest,
      name,
      email,
      password,
    };
    this.data.push(user);
    logger.info('user created', user);
    // emits an event (kafka message)
    yield userEvents.emit('created', user);
    return user;
  };

  // will be an endpoint
  this.get = function* get(request, context) {
    const id = request.id;
    const name = request.name;
    const email = request.email;
    for (const entry of this.data) {
      if (entry.id === id && id ||
        entry.name === name && name ||
        entry.email === email && email) {
        // Return a value for a successful request
        return entry;
      }
    }
    throw new Error('not found');
  };

  this.activate = function* activate() {
    throw new Error('not implemented');
  };
  this.changePassword = this.activate;
  this.unregister = this.activate;
}

co(function* init() {
  config.load(process.cwd() + '/example/user');

  // Create a new microservice Server
  const server = new Server();

  // get gss
  // const db = yield Database.get('gss', server.logger);

  // Add middleware
  // server.middleware.push(makeLogging(server.logger));

  // Subscribe to events which the business logic requires
  const userEvents = yield server.events.topic('user');

  // Create the business logic
  const service = new Service(userEvents, server.logger);

  // Bind business logic to server
  yield server.bind(service);

  // Start server
  yield server.start();
}).catch((err) => {
  /* eslint no-console: ["error", { allow: ["error"] }] */
  console.error('client error', err.stack);
  process.exit(1);
});
