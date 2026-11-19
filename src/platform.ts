import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import AnovaOvenService, { Recipe } from './AnovaOvenService';
import { AnovaOvenPlatformAccessory, OvenAccessoryOptions } from './platformAccessory';
import {
  DEFAULT_OVEN_MODE, DEFAULT_TEMPERATURE_F, fToC, isCookingMode, resolveRecipes, COOKING_MODES,
} from './recipes';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class AnovaOvenHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  private readonly anovaOvenService?: AnovaOvenService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    const token = typeof config.token === 'string' ? config.token.trim() : '';
    if (token && !token.startsWith('anova-')) {
      this.log.warn('The Anova personal access token should start with "anova-"; check that you copied all of it.');
    }
    if (!token && (!config.email || !config.password)) {
      this.log.error('Add an Anova personal access token (or your Anova email and password) in the plugin settings; '
        + 'the oven will not be available until you do.');
    } else {
      if (!token) {
        this.log.info('Signing in with email/password. A personal access token is recommended instead; see the plugin README.');
      }
      this.anovaOvenService = new AnovaOvenService({
        token: token || undefined,
        email: config.email,
        password: config.password,
        websocketUrl: config.websocketUrl,
        authUrl: config.authUrl,
      }, log);
    }

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
    this.api.on('shutdown', () => this.anovaOvenService?.stop());
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private get recipes(): Recipe[] {
    // `advancedRecipes` holds raw Anova stage lists (kept out of the settings form so the UI can't drop them).
    const advanced = Array.isArray(this.config.advancedRecipes) ? this.config.advancedRecipes : [];
    const simple = Array.isArray(this.config.recipes) ? this.config.recipes : [];
    const recipes = this.config.recipes !== undefined && !Array.isArray(this.config.recipes)
      ? this.config.recipes
      : [...simple, ...advanced];
    return resolveRecipes({ recipes, defaultRecipes: this.config.defaultRecipes }, this.log);
  }

  private get accessoryOptions(): OvenAccessoryOptions {
    const c = this.config;
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    if (c.ovenMode !== undefined && !isCookingMode(c.ovenMode)) {
      this.log.warn(`Unknown "ovenMode" "${c.ovenMode}"; using "${DEFAULT_OVEN_MODE}". `
        + `Valid modes: ${Object.keys(COOKING_MODES).join(', ')}.`);
    }
    const name = typeof c.mainSwitchName === 'string' && c.mainSwitchName.trim() ? c.mainSwitchName.trim() : 'Oven';
    const sensor = (key: string) => c[key] !== false;
    return {
      mainSwitchName: name,
      ovenMode: isCookingMode(c.ovenMode) ? c.ovenMode : DEFAULT_OVEN_MODE,
      defaultTemperatureC: fToC(num(c.defaultTemperatureF, DEFAULT_TEMPERATURE_F)),
      thermostat: c.thermostat !== false,
      sensors: {
        preheated: sensor('preheatedSensor'),
        done: sensor('doneSensor'),
        door: sensor('doorSensor'),
        waterTank: sensor('waterTankSensor'),
        descale: sensor('descaleSensor'),
        probe: sensor('probeSensor'),
      },
      maxCookHours: Math.max(0, num(c.maxCookHours, 3)),
    };
  }

  discoverDevices() {
    // Earlier versions stored the whole oven object (including the Anova password) in the accessory context,
    // which Homebridge writes to its cache file. Replace it with just the device ID.
    const scrubbed = this.accessories.filter((accessory) => accessory.context?.oven !== undefined);
    scrubbed.forEach((accessory) => {
      accessory.context = { deviceId: accessory.context.oven?._id ?? accessory.context.oven?.deviceId };
    });
    if (scrubbed.length) {
      this.api.updatePlatformAccessories(scrubbed);
    }

    const service = this.anovaOvenService;
    if (!service) {
      return;
    }
    const recipes = this.recipes;
    const options = this.accessoryOptions;

    service.on('ovenFound', (oven) => {
      const uuid = this.api.hap.uuid.generate(oven.deviceId);
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        // Keep saved settings (e.g. target temperature); drop anything else, such as the old oven object.
        const { targetC, autoOff } = existingAccessory.context ?? {};
        existingAccessory.context = { deviceId: oven.deviceId, targetC, autoOff };
        new AnovaOvenPlatformAccessory(this, existingAccessory, oven, recipes, options);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`Adding new accessory: ${oven.deviceId} ${oven.name}`);
        const accessory = new this.api.platformAccessory(oven.name, uuid);
        accessory.context = { deviceId: oven.deviceId };
        new AnovaOvenPlatformAccessory(this, accessory, oven, recipes, options);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    });
    service.start();
  }
}
