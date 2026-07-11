// Jest globalSetup — runs once before the whole suite.
//
// jim-tennis-deploy: upstream preflights the `link:../courthive-ingest` build
// here. That package is unpublished and the federation-data module that used
// it is removed from this deploy branch, so the preflight is a no-op.
module.exports = async function setup() {};
