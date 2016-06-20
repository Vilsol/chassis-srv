'use strict';

const mocha = require('mocha');
const coMocha = require('co-mocha');
coMocha(mocha);

const should = require('should');
const _ = require('lodash');

const errors = require('../').errors;

/* global describe it */

describe('error', () => {
  _.forEach(errors, (Error, name) => {
    describe(name, () => {
      it('should be an Error', () => {
        const error = new Error();
        should.exist(error);
        error.should.be.Error();
      });
    });
  });
});