import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { AnovaOven, Recipe } from './AnovaOvenService';
import { StagesEntity } from './AnovaTypes';
import { AnovaOvenHomebridgePlatform } from './platform';

/** Subtype/name of the main on/off switch. Unchanged from earlier versions so existing HomeKit setups keep working. */
const POWER_SWITCH_NAME = 'Power On';

/** After a tap, report the requested state for this long while waiting for the oven to confirm it. */
const STATE_UPDATE_TIMEOUT_MS = 5000;

const POWER_ON_DEFAULT_STAGES: StagesEntity[] = [
  {
    'title': 'Pre-heat',
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

type ManagedSwitch = {
  service: Service;
  currentValue: () => boolean;
};

export class AnovaOvenPlatformAccessory {
  private readonly switches: ManagedSwitch[] = [];

  constructor(
    readonly platform: AnovaOvenHomebridgePlatform,
    readonly accessory: PlatformAccessory,
    readonly oven: AnovaOven,
    readonly recipes: Recipe[],
  ) {
    const { Characteristic } = this.platform;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Anova Culinary')
      .setCharacteristic(Characteristic.Model, 'Precision Oven')
      .setCharacteristic(Characteristic.SerialNumber, oven.deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision,
        `FW: ${oven.state.systemInfo?.firmwareVersion}, HW: ${oven.state.systemInfo?.hardwareVersion}`);

    // The power switch is on whenever the oven is cooking anything, however it was started.
    const powerSwitch = this.createSwitch(
      POWER_SWITCH_NAME,
      () => this.oven.isOn,
      () => this.oven.startCook(POWER_ON_DEFAULT_STAGES),
    );
    powerSwitch.setPrimaryService(true);

    // Recipe switches are on only while that recipe's stages are the active cook.
    recipes.forEach((recipe) => this.createSwitch(
      recipe.name,
      () => this.oven.isCooking(recipe.stages),
      () => this.oven.startCook(recipe.stages),
    ));

    this.removeStaleSwitches([POWER_SWITCH_NAME, ...recipes.map((r) => r.name)]);

    // Push every switch's state to HomeKit whenever the oven reports a change.
    oven.on('ovenState', () => this.refresh());
    oven.on('cookStart', () => this.refresh());
    oven.on('cookEnd', () => this.refresh());

    oven.on('setName', (name) => {
      this.platform.log.debug('Setting name to', name);
      this.accessory.displayName = name;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    });
  }

  private refresh() {
    for (const sw of this.switches) {
      sw.service.updateCharacteristic(this.platform.Characteristic.On, sw.currentValue());
    }
  }

  private createSwitch(name: string, isActive: () => boolean, start: () => Promise<unknown>) {
    const { Characteristic, api } = this.platform;
    let sw = this.accessory.getServiceById(this.platform.Service.Switch, name);
    if (!sw) {
      sw = new this.platform.Service.Switch(name, name);
      sw.addOptionalCharacteristic(Characteristic.ConfiguredName);
      sw.setCharacteristic(Characteristic.Name, name);
      sw.setCharacteristic(Characteristic.ConfiguredName, name);
      this.accessory.addService(sw);
    }
    sw.displayName = name;
    this.platform.log.debug('Creating switch', name);

    let pendingState: boolean | undefined;
    let pendingStateExpiration = 0;
    const currentValue = () => {
      const actual = isActive();
      if (pendingState !== undefined && pendingState !== actual && Date.now() < pendingStateExpiration) {
        return pendingState;
      }
      pendingState = undefined;
      return actual;
    };

    sw.getCharacteristic(Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        this.platform.log.debug(`Set ${name} ->`, value);
        pendingState = Boolean(value);
        pendingStateExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
        try {
          if (value) {
            await start();
          } else {
            await this.oven.stopCook();
          }
        } catch (e) {
          pendingState = undefined;
          this.platform.log.error(`Could not turn ${name} ${value ? 'on' : 'off'}: ${e instanceof Error ? e.message : e}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      })
      .onGet(() => currentValue());

    this.switches.push({ service: sw, currentValue });
    return sw;
  }

  /** Remove switches for recipes that are no longer in the config. */
  private removeStaleSwitches(keep: string[]) {
    this.accessory.services
      .filter((service) => service.UUID === this.platform.Service.Switch.UUID && !keep.includes(service.subtype ?? ''))
      .forEach((service) => {
        this.platform.log.info(`Removing switch "${service.displayName}" (no longer in the recipe list)`);
        this.accessory.removeService(service);
      });
  }
}
