// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

/**
 * Reads the configuration on every connection; a failure is said in the
 * status and tried again (5 s, doubled up to 60 s), without end, until a
 * read succeeds or the connection is lost. The stops held in /data do not
 * wait for it (app.boot()).
 */
export function startWhenConfigured(gladys, app, logger) {
  const attempt = (app.connectAttempt ?? 0) + 1;
  app.connectAttempt = attempt;
  const { configRetry, configRetryMax } = app.timings;
  const run = async (delay) => {
    if (app.connectAttempt !== attempt) {
      return;
    }
    let config;
    try {
      config = await gladys.getConfig();
    } catch (err) {
      logger?.warn(`Could not read the configuration: ${err.message}`);
      await app.configUnread();
      app.later(() => run(Math.min(delay * 2, configRetryMax)), delay);
      return;
    }
    if (app.connectAttempt === attempt) {
      await app.connected(config);
    }
  };
  return run(configRetry);
}

export function registerHandlers(gladys, app, logger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // The commands. A failure is logged here: the SDK only acks it to Gladys.
  gladys.onSetValue(async (device, feature, value) => {
    try {
      await app.setValue(device, feature, value);
    } catch (err) {
      logger?.warn(`Command ${feature?.external_id} refused: ${err.message}`);
      throw err;
    }
  });

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys).
  gladys.on('connected', async () => {
    try {
      await startWhenConfigured(gladys, app, logger);
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
  gladys.on('disconnected', () => {
    // A pending getConfig() retry stops: the next connection starts its own.
    app.connectAttempt = (app.connectAttempt ?? 0) + 1;
  });
}
