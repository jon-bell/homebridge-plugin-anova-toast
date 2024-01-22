import { CharacteristicValue, PlatformAccessory } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';
import { AnovaOven, Recipe } from './AnovaOvenService';
import { StagesEntity } from './AnovaTypes';
import { AnovaOvenHomebridgePlatform } from './platform';

export class AnovaOvenPlatformAccessory {

  constructor(
    readonly platform: AnovaOvenHomebridgePlatform,
    readonly accessory: PlatformAccessory,
    readonly oven: AnovaOven,
    readonly recipes: Recipe[],
  ) {
    const createSwitchForRecipe = (recipe: Recipe) => {
      let sw = this.accessory.getService(recipe.name);
      if (!sw) {
        sw = new this.platform.api.hap.Service.Switch(recipe.name, recipe.name);
        sw.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
        sw.setCharacteristic(this.platform.Characteristic.Name, recipe.name);
        sw.setCharacteristic(this.platform.Characteristic.ConfiguredName, recipe.name);
        this.accessory.addService(sw);
      }

      sw.displayName = recipe.name;
      this.platform.log.debug('Creating switch for recipe', recipe.name);

      let pendingState = this.oven.isCooking(recipe.stages);
      const STATE_UPDATE_TIMEOUT_MS = 3000;
      let pendingStateExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
      sw.getCharacteristic(this.platform.Characteristic.On)
        .onSet(async (value: CharacteristicValue) => {
          this.platform.log.debug(`Set Recipe ${recipe.name} On ->`, value);
          try {
            if (!value) {
              pendingState = false;
              pendingStateExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
              await this.oven.stopCook();
            } else {
              pendingState = true;
              pendingStateExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
              await this.oven.startCook(recipe.stages);
            }
          } catch (e) {
            this.platform.log.error('Error setting recipe', e);
            throw e;
          }
        },
        )
        .onGet(() => {
          const curState = this.oven.isCooking(recipe.stages);
          if (pendingState !== curState && Date.now() < pendingStateExpiration) {
            return pendingState;
          }
          return curState;
        });
      return sw;
    };
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Anova Culinary')
      .setCharacteristic(this.platform.Characteristic.Model, 'Precision Oven')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, oven.deviceId)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision,
        `FW: ${oven.state.systemInfo.firmwareVersion}, HW: ${oven.state.systemInfo.hardwareVersion}`);


    const POWER_ON_DEFAULT_STAGES: StagesEntity[] = [
      {
        'title': 'Pre-heat',
        'id': uuidv4(),
        'type': 'preheat',
        'userActionRequired': false,
        'temperatureBulbs': {
          'mode': 'dry',
          'dry': {
            'setpoint': {
              'celsius': 176.67,
              'fahrenheit': 350,
            },
          },
        },
        'heatingElements': {
          'top': {
            'on': false,
          },
          'bottom': {
            'on': true,
          },
          'rear': {
            'on': false,
          },
        },
        'fan': {
          'speed': 33,
        },
        'vent': {
          'open': false,
        },
      },
      {
        'title': 'Bake',
        'id': uuidv4(),
        'type': 'cook',
        'userActionRequired': false,
        'temperatureBulbs': {
          'mode': 'dry',
          'dry': {
            'setpoint': {
              'celsius': 176.67,
              'fahrenheit': 350,
            },
          },
        },
        'heatingElements': {
          'top': {
            'on': false,
          },
          'bottom': {
            'on': true,
          },
          'rear': {
            'on': false,
          },
        },
        'fan': {
          'speed': 33,
        },
        'vent': {
          'open': false,
        },
      },
    ];

    const powerOnButton = createSwitchForRecipe({ name: 'Power On', stages: POWER_ON_DEFAULT_STAGES });
    powerOnButton.setPrimaryService(true);

    oven.on('cookStart', () => {
      powerOnButton.updateCharacteristic(this.platform.Characteristic.On, true);
    });
    oven.on('cookEnd', () => {
      powerOnButton.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    oven.on('setName', (name) => {
      const accessoryInformation = this.accessory.getService(this.platform.Service.AccessoryInformation);
      if (accessoryInformation) {
        this.platform.log.debug('Setting name to', name);
        this.accessory.displayName = name;
        //TODO - this doesn't seem to work
        accessoryInformation.setCharacteristic(this.platform.Characteristic.Name, name);
        accessoryInformation.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
      }
      this.platform.api.updatePlatformAccessories([this.accessory]);
    });

    recipes.forEach(createSwitchForRecipe);
  }
}