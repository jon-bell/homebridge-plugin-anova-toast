import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import AnovaOvenService from './AnovaOvenService';
import { AnovaOvenPlatformAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class AnovaOvenHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  private readonly anovaOvenService: AnovaOvenService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.anovaOvenService = new AnovaOvenService({ email: config.email, password: config.password }, log);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  async discoverDevices() {

    this.anovaOvenService.login();
    this.anovaOvenService.on('ovenFound', (oven) => {
      this.log.info('Oven found. Registering toast accessory on', oven.deviceId);

      const uuid = this.api.hap.uuid.generate(oven.deviceId);
      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        new AnovaOvenPlatformAccessory(this, existingAccessory, oven, this.config.recipes);
        oven.name = `${oven.name}`;
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info(`Adding new accessory: ${oven.deviceId} ${oven.name}`);

        const accessory = new this.api.platformAccessory(oven.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.oven = oven;

        new AnovaOvenPlatformAccessory(this, accessory, oven, this.config.recipes);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

    });
  }
}
