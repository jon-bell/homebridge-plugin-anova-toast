import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import AnovaOvenService, { Recipe } from './AnovaOvenService';
import { DEFAULT_RECIPES } from './defaultRecipes';
import { AnovaOvenPlatformAccessory } from './platformAccessory';
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
    if (this.config.recipes === undefined) {
      return DEFAULT_RECIPES;
    }
    if (!Array.isArray(this.config.recipes)) {
      this.log.error('"recipes" in the plugin config must be a list; using the default recipes instead.');
      return DEFAULT_RECIPES;
    }
    return (this.config.recipes as Recipe[]).filter((recipe, idx) => {
      if (typeof recipe?.name !== 'string' || !recipe.name || !Array.isArray(recipe.stages) || recipe.stages.length === 0) {
        this.log.warn(`Skipping recipe #${idx + 1}: each recipe needs a "name" and a non-empty "stages" list.`);
        return false;
      }
      return true;
    });
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

    service.on('ovenFound', (oven) => {
      const uuid = this.api.hap.uuid.generate(oven.deviceId);
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context = { deviceId: oven.deviceId };
        new AnovaOvenPlatformAccessory(this, existingAccessory, oven, recipes);
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.log.info(`Adding new accessory: ${oven.deviceId} ${oven.name}`);
        const accessory = new this.api.platformAccessory(oven.name, uuid);
        accessory.context = { deviceId: oven.deviceId };
        new AnovaOvenPlatformAccessory(this, accessory, oven, recipes);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    });
    service.start();
  }
}
