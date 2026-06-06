// metro.config.js
// Wraps the default Expo Metro config with Sentry's serializer so that
// source maps are generated correctly for readable stack traces in Sentry.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = config;
