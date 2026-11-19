import { CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import { AnovaOven, Recipe } from './AnovaOvenService';
import { StagesEntity } from './AnovaTypes';
import { AnovaOvenHomebridgePlatform } from './platform';
import {
  buildStages, clampTemperatureC, CookingMode, COOKING_MODES, MAX_DRY_TEMP_C, MIN_TEMP_C, retargetStages,
} from './recipes';

/** Subtype of the main on/off switch. Unchanged from earlier versions so existing HomeKit setups keep working. */
const MAIN_SWITCH_SUBTYPE = 'Power On';
/** Name the main switch had before it became configurable; renamed to the configured name if still unchanged. */
const LEGACY_MAIN_SWITCH_NAME = 'Power On';

/** After a tap, report the requested state for this long while waiting for the oven to confirm it. */
const STATE_UPDATE_TIMEOUT_MS = 5000;
/**
 * Siri and grouped Home tiles turn on every switch of the accessory at once. "On" requests arriving
 * within this window are treated as one request, and only the highest-priority one starts a cook.
 */
const START_BURST_WINDOW_MS = 400;
/** Wait this long after the last temperature change (e.g. dragging the slider) before restarting the cook. */
const TEMPERATURE_CHANGE_DEBOUNCE_MS = 1500;
const AUTO_OFF_CHECK_INTERVAL_MS = 60_000;

const PRIORITY_MAIN = 2;
const PRIORITY_RECIPE = 1;

export type OvenAccessoryOptions = {
  mainSwitchName: string;
  /** Heating setup used by the main switch and the thermostat. */
  ovenMode: CookingMode;
  /** Starting target temperature for the main switch and thermostat. */
  defaultTemperatureC: number;
  thermostat: boolean;
  sensors: {
    preheated: boolean;
    done: boolean;
    door: boolean;
    waterTank: boolean;
    descale: boolean;
    probe: boolean;
  };
  /** Turn off cooks started from HomeKit after this many hours (plus any timer). 0 disables. */
  maxCookHours: number;
};

/** Persisted in accessory.context (and so in Homebridge's cache). Never put credentials here. */
type OvenContext = {
  deviceId: string;
  targetC?: number;
  autoOff?: { cookId: string; deadline: number; armedAt: number };
};

/** Ignore state updates that still show the previous cook for this long after starting a new one. */
const AUTO_OFF_GRACE_MS = 15_000;

type StartRequest = {
  name: string;
  priority: number;
  start: () => Promise<string>;
  resolve: () => void;
  reject: (e: unknown) => void;
};

type ManagedSwitch = {
  service: Service;
  currentValue: () => boolean;
  clearPending: () => void;
};

export class AnovaOvenPlatformAccessory {
  private readonly switches: ManagedSwitch[] = [];
  private readonly refreshers: (() => void)[] = [];
  private pendingStarts: StartRequest[] = [];
  private startTimer?: NodeJS.Timeout;
  private preheatedCookId?: string;
  private readonly autoOffTimer: NodeJS.Timeout;

  constructor(
    readonly platform: AnovaOvenHomebridgePlatform,
    readonly accessory: PlatformAccessory,
    readonly oven: AnovaOven,
    readonly recipes: Recipe[],
    readonly options: OvenAccessoryOptions,
  ) {
    const { Characteristic, Service } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Anova Culinary')
      .setCharacteristic(Characteristic.Model, 'Precision Oven')
      .setCharacteristic(Characteristic.SerialNumber, oven.deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision,
        `FW: ${oven.state.systemInfo?.firmwareVersion}, HW: ${oven.state.systemInfo?.hardwareVersion}`);

    // Main switch: on whenever the oven is cooking anything; turning it on cooks at the thermostat's target.
    const mainSwitch = this.createSwitch({
      subtype: MAIN_SWITCH_SUBTYPE,
      name: options.mainSwitchName,
      priority: PRIORITY_MAIN,
      isActive: () => this.oven.isOn,
      start: () => this.startMainCook(),
      stopsAnyCook: true,
    });
    mainSwitch.setPrimaryService(true);

    // Recipe switches: on only while that recipe is the active cook.
    recipes.forEach((recipe) => this.createSwitch({
      subtype: recipe.name,
      name: recipe.name,
      priority: PRIORITY_RECIPE,
      isActive: () => this.oven.isCooking(recipe.stages),
      start: () => this.startTracked(recipe.stages),
      stopsAnyCook: false,
    }));
    this.removeStale(Service.Switch, [MAIN_SWITCH_SUBTYPE, ...recipes.map((r) => r.name)], 'switch');

    this.setUpThermostat();
    this.setUpSensors();

    oven.on('ovenState', () => this.refresh());
    oven.on('cookStart', () => this.refresh());
    oven.on('cookEnd', () => this.refresh());
    oven.on('setName', (name) => {
      this.platform.log.debug('Setting name to', name);
      this.accessory.displayName = name;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    });

    this.autoOffTimer = setInterval(() => this.checkAutoOff(), AUTO_OFF_CHECK_INTERVAL_MS);
    this.platform.api.on('shutdown', () => clearInterval(this.autoOffTimer));
    this.refresh();
  }

  private get context(): OvenContext {
    return this.accessory.context as OvenContext;
  }

  private saveContext() {
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  private get targetC(): number {
    return clampTemperatureC(this.context.targetC ?? this.options.defaultTemperatureC, this.options.ovenMode);
  }

  private refresh() {
    for (const sw of this.switches) {
      sw.service.updateCharacteristic(this.platform.Characteristic.On, sw.currentValue());
    }
    this.refreshers.forEach((fn) => fn());
    this.checkAutoOff();
  }

  // ---- Starting and stopping ---------------------------------------------------------------------

  /** Start the main cook: the configured heating mode at the thermostat's target temperature. */
  private startMainCook() {
    return this.startTracked(buildStages({ mode: this.options.ovenMode, temperatureC: this.targetC }));
  }

  /** Start a cook from HomeKit and arm the auto-off safety limit for it. */
  private async startTracked(stages: StagesEntity[]) {
    const cookId = await this.oven.startCook(stages);
    if (this.options.maxCookHours > 0) {
      const timerSeconds = stages.reduce((sum, s) => sum + (s.timer?.initial ?? 0), 0);
      const now = Date.now();
      this.context.autoOff = { cookId, armedAt: now, deadline: now + this.options.maxCookHours * 3_600_000 + timerSeconds * 1000 };
    } else {
      delete this.context.autoOff;
    }
    this.saveContext();
    return cookId;
  }

  /** Queue a start; within a short window only the highest-priority request runs (see START_BURST_WINDOW_MS). */
  private requestStart(name: string, priority: number, start: () => Promise<string>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingStarts.push({ name, priority, start, resolve, reject });
      if (!this.startTimer) {
        this.startTimer = setTimeout(() => void this.flushStarts(), START_BURST_WINDOW_MS);
      }
    });
  }

  private async flushStarts() {
    const requests = this.pendingStarts;
    this.pendingStarts = [];
    this.startTimer = undefined;
    const winner = requests.reduce((best, r) => (r.priority > best.priority ? r : best), requests[0]);
    if (requests.length > 1) {
      this.platform.log.info(`${requests.length} controls were turned on at once (${requests.map((r) => r.name).join(', ')}); `
        + `starting only "${winner.name}".`);
      this.switches.forEach((sw) => {
        if (sw.service.subtype !== winner.name && sw.service.displayName !== winner.name) {
          sw.clearPending();
        }
      });
    }
    try {
      await winner.start();
      requests.forEach((r) => r.resolve());
    } catch (e) {
      requests.forEach((r) => r.reject(e));
    } finally {
      setTimeout(() => this.refresh(), 50);
    }
  }

  private async stop(reason: string) {
    if (!this.oven.isOn) {
      return;
    }
    this.platform.log.info(`Stopping the oven (${reason})`);
    await this.oven.stopCook();
  }

  private checkAutoOff() {
    const autoOff = this.context.autoOff;
    if (!autoOff) {
      return;
    }
    const cook = this.oven.state.cook;
    if (!cook || cook.cookId !== autoOff.cookId) {
      // That cook ended or was replaced (e.g. from the Anova app); nothing to enforce.
      if (Date.now() - (autoOff.armedAt ?? 0) > AUTO_OFF_GRACE_MS) {
        delete this.context.autoOff;
        this.saveContext();
      }
      return;
    }
    if (Date.now() >= autoOff.deadline) {
      delete this.context.autoOff;
      this.saveContext();
      this.platform.log.warn(`Turning the oven off: a cook started from HomeKit has been running longer than the ${
        this.options.maxCookHours} hour limit ("maxCookHours" in the plugin settings).`);
      this.oven.stopCook().catch((e) => this.platform.log.error(`Auto-off failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  // ---- Switches ----------------------------------------------------------------------------------

  private createSwitch(opts: {
    subtype: string;
    name: string;
    priority: number;
    isActive: () => boolean;
    start: () => Promise<string>;
    /** Main switch: turning it off stops whatever is cooking. Recipe switches only stop their own recipe. */
    stopsAnyCook: boolean;
  }) {
    const { Characteristic, api } = this.platform;
    let sw = this.accessory.getServiceById(this.platform.Service.Switch, opts.subtype);
    if (!sw) {
      sw = new this.platform.Service.Switch(opts.name, opts.subtype);
      sw.addOptionalCharacteristic(Characteristic.ConfiguredName);
      sw.setCharacteristic(Characteristic.Name, opts.name);
      sw.setCharacteristic(Characteristic.ConfiguredName, opts.name);
      this.accessory.addService(sw);
    } else if (opts.subtype === MAIN_SWITCH_SUBTYPE && opts.name !== LEGACY_MAIN_SWITCH_NAME
      && sw.getCharacteristic(Characteristic.ConfiguredName).value === LEGACY_MAIN_SWITCH_NAME) {
      // Still has the old default name (not renamed in the Home app): apply the new name.
      sw.setCharacteristic(Characteristic.Name, opts.name);
      sw.setCharacteristic(Characteristic.ConfiguredName, opts.name);
    }
    sw.displayName = opts.name;
    this.platform.log.debug('Creating switch', opts.name);

    let pendingState: boolean | undefined;
    let pendingStateExpiration = 0;
    const currentValue = () => {
      const actual = opts.isActive();
      if (pendingState !== undefined && pendingState !== actual && Date.now() < pendingStateExpiration) {
        return pendingState;
      }
      pendingState = undefined;
      return actual;
    };

    sw.getCharacteristic(Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        this.platform.log.debug(`Set ${opts.name} ->`, value);
        pendingState = Boolean(value);
        pendingStateExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
        try {
          if (value) {
            if (!opts.isActive()) {
              await this.requestStart(opts.name, opts.priority, opts.start);
            }
          } else if (opts.stopsAnyCook || opts.isActive()) {
            await this.stop(`${opts.name} turned off`);
          } else {
            // Turning off a recipe that isn't the one cooking leaves the current cook alone.
            pendingState = undefined;
            setTimeout(() => this.refresh(), 50);
          }
        } catch (e) {
          pendingState = undefined;
          this.platform.log.error(`Could not turn ${opts.name} ${value ? 'on' : 'off'}: ${e instanceof Error ? e.message : e}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      })
      .onGet(() => currentValue());

    this.switches.push({ service: sw, currentValue, clearPending: () => (pendingState = undefined) });
    return sw;
  }

  // ---- Thermostat --------------------------------------------------------------------------------

  private setUpThermostat() {
    const { Characteristic, Service } = this.platform;
    const { api, log } = this.platform;
    if (!this.options.thermostat) {
      this.removeStale(Service.Thermostat, [], 'thermostat');
      return;
    }
    const name = `${this.options.mainSwitchName} Temperature`;
    const svc = this.getOrAddService(Service.Thermostat, name, 'thermostat');
    const maxC = COOKING_MODES[this.options.ovenMode].bulb === 'wet' ? 100 : MAX_DRY_TEMP_C;

    svc.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 300, minStep: 0.1 })
      .onGet(() => this.oven.currentTemperatureC ?? 0);

    // Widen the range first, move the value into it, then raise the minimum. Setting the minimum straight
    // away makes HAP warn about HomeKit's default value (10 °C) being out of range.
    const targetTemp = svc.getCharacteristic(Characteristic.TargetTemperature);
    targetTemp.setProps({ maxValue: maxC, minStep: 0.5 });
    targetTemp.updateValue(this.displayedTargetC());
    targetTemp.setProps({ minValue: MIN_TEMP_C });
    targetTemp
      .onGet(() => this.displayedTargetC())
      .onSet((value: CharacteristicValue) => {
        const celsius = Number(value);
        this.context.targetC = celsius;
        this.saveContext();
        if (this.oven.isOn) {
          this.scheduleRetarget(celsius);
        }
      });

    svc.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({ validValues: [Characteristic.CurrentHeatingCoolingState.OFF, Characteristic.CurrentHeatingCoolingState.HEAT] })
      .onGet(() => (this.oven.isOn ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF));

    let pendingTarget: number | undefined;
    let pendingTargetExpiration = 0;
    svc.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT] })
      .onGet(() => {
        const actual = this.oven.isOn ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF;
        return pendingTarget !== undefined && Date.now() < pendingTargetExpiration ? pendingTarget : actual;
      })
      .onSet(async (value: CharacteristicValue) => {
        pendingTarget = Number(value);
        pendingTargetExpiration = Date.now() + STATE_UPDATE_TIMEOUT_MS;
        try {
          if (value === Characteristic.TargetHeatingCoolingState.HEAT) {
            if (!this.oven.isOn) {
              await this.requestStart(name, PRIORITY_MAIN, () => this.startMainCook());
            }
          } else {
            await this.stop(`${name} turned off`);
          }
        } catch (e) {
          pendingTarget = undefined;
          log.error(`Could not change ${name}: ${e instanceof Error ? e.message : e}`);
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    svc.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => (this.oven.temperatureUnit === 'C'
        ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT))
      .onSet(() => undefined);

    this.refreshers.push(() => {
      svc.updateCharacteristic(Characteristic.CurrentTemperature, this.oven.currentTemperatureC ?? 0);
      svc.updateCharacteristic(Characteristic.TargetTemperature, this.displayedTargetC());
      svc.updateCharacteristic(Characteristic.CurrentHeatingCoolingState,
        this.oven.isOn ? Characteristic.CurrentHeatingCoolingState.HEAT : Characteristic.CurrentHeatingCoolingState.OFF);
      if (Date.now() >= pendingTargetExpiration) {
        svc.updateCharacteristic(Characteristic.TargetHeatingCoolingState,
          this.oven.isOn ? Characteristic.TargetHeatingCoolingState.HEAT : Characteristic.TargetHeatingCoolingState.OFF);
      }
    });
  }

  /** While cooking, the active stage's setpoint; otherwise the saved target. Clamped to the characteristic's range. */
  private displayedTargetC() {
    const maxC = COOKING_MODES[this.options.ovenMode].bulb === 'wet' ? 100 : MAX_DRY_TEMP_C;
    const c = (this.oven.isOn ? this.oven.setpointC : undefined) ?? this.targetC;
    return Math.min(maxC, Math.max(MIN_TEMP_C, c));
  }

  private retargetTimer?: NodeJS.Timeout;

  /** Change the temperature of the running cook (debounced), keeping its heating mode and any remaining timer. */
  private scheduleRetarget(celsius: number) {
    if (this.retargetTimer) {
      clearTimeout(this.retargetTimer);
    }
    this.retargetTimer = setTimeout(() => {
      this.retargetTimer = undefined;
      const stage = this.oven.activeStage;
      if (!this.oven.isOn || !stage) {
        return;
      }
      if (this.oven.setpointC !== undefined && Math.abs(this.oven.setpointC - celsius) < 0.25) {
        return;
      }
      const timer = this.oven.state.nodes?.timer;
      const remaining = timer?.mode === 'running' ? timer.current : stage.timer?.initial;
      this.platform.log.info(`Changing the oven temperature to ${Math.round(celsius)}°C (restarting the cook at the new temperature)`);
      this.startTracked(retargetStages(stage, celsius, remaining))
        .catch((e) => this.platform.log.error(`Could not change the temperature: ${e instanceof Error ? e.message : e}`));
    }, TEMPERATURE_CHANGE_DEBOUNCE_MS);
  }

  // ---- Sensors -----------------------------------------------------------------------------------

  private setUpSensors() {
    const { Characteristic, Service } = this.platform;
    const base = this.options.mainSwitchName;
    const { sensors } = this.options;

    this.sensor(sensors.preheated, Service.OccupancySensor, `${base} Preheated`, 'preheated', (svc) => {
      const cookId = this.oven.state.cook?.cookId;
      if (cookId && this.oven.isPreheated) {
        // Latch for the rest of this cook, so opening the door (and the temperature dipping) doesn't flip it back.
        this.preheatedCookId = cookId;
      }
      const preheated = Boolean(cookId && this.preheatedCookId === cookId);
      svc.updateCharacteristic(Characteristic.OccupancyDetected, preheated ? 1 : 0);
    });

    this.sensor(sensors.done, Service.OccupancySensor, `${base} Done`, 'done', (svc) => {
      svc.updateCharacteristic(Characteristic.OccupancyDetected, this.oven.isDone ? 1 : 0);
    });

    this.sensor(sensors.door, Service.ContactSensor, `${base} Door`, 'door', (svc) => {
      svc.updateCharacteristic(Characteristic.ContactSensorState, this.oven.isDoorClosed
        ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    });

    this.sensor(sensors.waterTank, Service.OccupancySensor, `${base} Water Tank Empty`, 'water-tank', (svc) => {
      svc.updateCharacteristic(Characteristic.OccupancyDetected, this.oven.isWaterTankEmpty ? 1 : 0);
    });

    this.sensor(sensors.descale, Service.OccupancySensor, `${base} Needs Descaling`, 'descale', (svc) => {
      svc.updateCharacteristic(Characteristic.OccupancyDetected, this.oven.needsDescaling ? 1 : 0);
    });

    let probePropsSet = false;
    this.sensor(sensors.probe, Service.TemperatureSensor, `${base} Food Probe`, 'probe', (svc) => {
      const probe = this.oven.probe;
      if (!probePropsSet) {
        svc.getCharacteristic(Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 300, minStep: 0.1 });
        probePropsSet = true;
      }
      svc.updateCharacteristic(Characteristic.CurrentTemperature, probe.celsius ?? 0);
      svc.updateCharacteristic(Characteristic.StatusActive, probe.connected);
    });
  }

  private sensor(enabled: boolean, type: WithUUID<typeof Service>, name: string, subtype: string, update: (svc: Service) => void) {
    if (!enabled) {
      this.removeStale(type, [], subtype);
      return;
    }
    const svc = this.getOrAddService(type, name, subtype);
    const run = () => update(svc);
    run();
    this.refreshers.push(run);
  }

  // ---- Helpers -----------------------------------------------------------------------------------

  private getOrAddService(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const { Characteristic } = this.platform;
    let svc = this.accessory.getServiceById(type, subtype);
    if (!svc) {
      svc = new type(name, subtype);
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.Name, name);
      svc.setCharacteristic(Characteristic.ConfiguredName, name);
      this.accessory.addService(svc);
    }
    return svc;
  }

  /**
   * Remove services of `type` whose subtype isn't in `keep`. With a single `onlySubtype`-style call
   * (keep = [], subtype given as label), removes just that subtype.
   */
  private removeStale(type: WithUUID<typeof Service>, keep: string[], label: string) {
    this.accessory.services
      .filter((svc) => svc.UUID === type.UUID && svc.subtype !== undefined
        && (keep.length ? !keep.includes(svc.subtype) : svc.subtype === label))
      .forEach((svc) => {
        const why = keep.length ? 'no longer in the recipe list' : 'turned off in settings';
        this.platform.log.info(`Removing "${svc.displayName}" (${why})`);
        this.accessory.removeService(svc);
      });
  }
}
