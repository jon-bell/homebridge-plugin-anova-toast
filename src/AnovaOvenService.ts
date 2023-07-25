import axios from 'axios';
import EventEmitter from 'events';
import TypedEventEmitter from 'typed-emitter';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import {
  AnovaOvenEvent, DeviceID, OvenCommand, OvenCommandResponse, OvenResponse, OvenStateMessage,
  StagesEntity, StartCookPayload, SteamGenerators, TemperatureBulbSetPoint,
} from './AnovaTypes';
import { Logger } from 'homebridge';

const steamGeneratorsEqual = (a: SteamGenerators | undefined, b: SteamGenerators | undefined) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === 'steam-percentage') {
    return a.steamPercentage?.setpoint === b.steamPercentage?.setpoint;
  } else if(a.mode === 'relative-humidity'){
    return a.relativeHumidity?.setpoint === b.relativeHumidity?.setpoint;
  } else {
    throw `Unknown steam mode ${a.mode}`;
  }
};
const temperatureBulbsEqual = (a: TemperatureBulbSetPoint, b: TemperatureBulbSetPoint) => {
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === 'dry' && b.mode === 'dry') {
    return a.dry.setpoint.celsius === b.dry.setpoint.celsius;
  } else if(a.mode === 'wet' && b.mode === 'wet'){
    return a.wet.setpoint.celsius === b.wet.setpoint.celsius;
  } else {
    throw `Unknown temp bulb mode ${a.mode}`;
  }
};
const stagesEqual = (stage1: StagesEntity, stage2: StagesEntity) => {
  return stage1.fan.speed === stage2.fan.speed &&
    stage1.heatingElements.bottom.on === stage2.heatingElements.bottom.on &&
    stage1.heatingElements.rear.on === stage2.heatingElements.rear.on &&
    stage1.heatingElements.top.on === stage2.heatingElements.top.on &&
    steamGeneratorsEqual(stage1.steamGenerators, stage2.steamGenerators) &&
    temperatureBulbsEqual(stage1.temperatureBulbs, stage2.temperatureBulbs) &&
    stage1.vent.open === stage2.vent.open;
};

export class AnovaOven extends (EventEmitter as new () => TypedEventEmitter<AnovaOvenEvent>) {
  private _id: DeviceID;
  private _name: string;
  private _curStateMessage: OvenStateMessage;
  private _service: AnovaOvenService;

  public constructor(id: DeviceID, name: string, startingState: OvenStateMessage, service: AnovaOvenService) {
    super();
    this._id = id;
    this._name = name;
    this.on('ovenState', (update) => {
      const prevCook = this._curStateMessage.cook;
      this._curStateMessage = update;
      if (update.cook && !prevCook) {
        this._service.log.info(`Oven ${this._id} started cooking`);
        this.emit('cookStart', update.cook);
      } else if (prevCook && !update.cook) {
        this._service.log.info(`Oven ${this._id} stopped cooking`);
        this.emit('cookEnd');
      }
    });
    this._curStateMessage = startingState;
    this._service = service;
  }

  public set name(name: string) {
    this.emit('setName', name);
    this._name = name;
  }

  public get name() {
    return this._name;
  }

  public set curStateMessage(update: OvenStateMessage) {
    this.emit('ovenState', update);
    if (update.state.mode !== this._curStateMessage.state.mode) {
      this._service.log.info(`Oven ${this._id} is in state ${update.state.mode}`);
    }
    this._curStateMessage = update;
  }

  public get isOn(): boolean {
    return this._curStateMessage.state.mode === 'cook';
  }

  public get deviceId(): DeviceID {
    return this._id;
  }

  public get state(): OvenStateMessage {
    return this._curStateMessage;
  }


  private async _startCook(payload: StartCookPayload) {
    await this._service.sendOvenCommand('CMD_APO_START', {
      payload: payload,
      type: 'CMD_APO_START',
      id: this._id,
    });
  }

  public async stopCook() {
    await this._service.sendOvenCommand('CMD_APO_STOP', {
      type: 'CMD_APO_STOP',
      id: this._id,
    });
  }

  /**
   * Convenience method for starting a cook givnen a set of stages.
   * Ensures that a UUID is set on each stage
   * Returns the cook ID
   *
   * @param stages
   */
  public async startCook(stages: StagesEntity[]) {
    stages.forEach(eachStage => {
      if (!eachStage.id) {
        eachStage.id = uuidv4();
      }
    });
    const cookId = uuidv4();
    await this._startCook({ cookId, stages });
    return cookId;
  }

  /**
   * Returns true if the currently active cook has the same stages (by object equality, does not rely on stage ID or cook ID)
   * @param stages
   */
  public isCooking(stages: StagesEntity[]) {
    const curCook = this._curStateMessage?.cook;
    if (!curCook) {
      return false;
    }
    if (curCook.stages.length !== stages.length) {
      return false;
    }
    return stages.every((v, idx) => stagesEqual(v, curCook.stages[idx]));
  }

  public async makeToast() {
    const toastStepIDs = [uuidv4(), uuidv4(), uuidv4()];
    const newToast: StartCookPayload = {
      cookId: uuidv4(),
      stages: [
        {
          'title': 'Start Cook',
          'id': toastStepIDs[0],
          'type': 'cook',
          'userActionRequired': true,
          'temperatureBulbs': {
            'mode': 'dry',
            'dry': {
              'setpoint': {
                'celsius': 250,
                'fahrenheit': 482,
              },
            },
          },
          'timer': {
            'initial': 180,
          },
          'heatingElements': {
            'top': {
              'on': true,
            },
            'bottom': {
              'on': false,
            },
            'rear': {
              'on': false,
            },
          },
          'fan': {
            'speed': 0,
          },
          'vent': {
            'open': false,
          },
        },
        {
          'title': 'Add Steam',
          'id': toastStepIDs[1],
          'type': 'cook',
          'userActionRequired': false,
          'temperatureBulbs': {
            'mode': 'dry',
            'dry': {
              'setpoint': {
                'celsius': 250,
                'fahrenheit': 482,
              },
            },
          },
          'steamGenerators': {
            'mode': 'steam-percentage',
            'steamPercentage': {
              'setpoint': 100,
            },
          },
          'timer': {
            'initial': 240,
          },
          'heatingElements': {
            'top': {
              'on': false,
            },
            'bottom': {
              'on': false,
            },
            'rear': {
              'on': true,
            },
          },
          'fan': {
            'speed': 100,
          },
          'vent': {
            'open': false,
          },
        },
        {
          'title': 'Cool Down',
          'id': toastStepIDs[2],
          'type': 'cook',
          'userActionRequired': false,
          'temperatureBulbs': {
            'mode': 'dry',
            'dry': {
              'setpoint': {
                'celsius': 25,
                'fahrenheit': 77,
              },
            },
          },
          'timer': {
            'initial': 60,
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
            'speed': 0,
          },
          'vent': {
            'open': false,
          },
        },
      ],
    };
    await this._startCook(newToast);
    return newToast.cookId;
  }

}
export type AnovaOvenServiceResponse = {
  authenticated: () => void;
  ovenFound: (oven: AnovaOven) => void;
  commandResponse: (response: OvenCommandResponse) => void;
};
export type Recipe = {
  name: string;
  stages: StagesEntity[];
};

export default class AnovaOvenService extends (EventEmitter as new () => TypedEventEmitter<AnovaOvenServiceResponse>) {

  private _email: string;
  private _password: string;
  private _socket: WebSocket;
  public log: Logger;
  public readonly ovens: Map<DeviceID, AnovaOven> = new Map();

  public constructor(args: { email: string; password: string }, logger: Logger) {
    super();
    this._email = args.email;
    this.log = logger;
    this._password = args.password;
  }

  public async login(): Promise<void> {
    // login to google firebase
    // get token
    const { data } = await axios({
      method: 'post',
      url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCGJwHXUhkNBdPkH3OAkjc9-3xMMjvanfU',
      headers: { 'content-type': 'application/json' },
      data: {
        email: this._email,
        password: this._password,
        returnSecureToken: true,
      },
    });

    return new Promise((resolve, reject) => {
      //open socket to API
      this._socket = new WebSocket(`wss://devices.anovaculinary.io/?token=${data.idToken}&supportedAccessories=APO&platform=android`,
        'ANOVA_V2');


      let authenticated = false;
      this._socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as OvenResponse;
        if (message.command === 'EVENT_APO_WIFI_LIST' && !authenticated) {
          authenticated = true;
          this.emit('authenticated');
        }
        this._dispatchToOven(message);
      });

      const timeout = setTimeout(() => {
        reject('Timeout connecting to API or authentication failed');
      }, 15000);
      this.once('authenticated', () => {
        clearTimeout(timeout);
        resolve();
      });
    },
    );
  }

  private _pendingOvens: { cookerId: DeviceID; name: string }[] = [];
  private _dispatchToOven(message: OvenResponse) {
    if (message.command === 'EVENT_APO_WIFI_LIST') {
      message.payload.forEach((oven) => {
        const existingOven = this.ovens.get(oven.cookerId);
        if (existingOven) {
          existingOven.name = oven.name;
        } else {
          this._pendingOvens.push({ cookerId: oven.cookerId, name: oven.name });
        }
      });
    } else if (message.command === 'EVENT_APO_STATE') {
      const ovenId = message.payload.cookerId;
      this.log.info(`Oven ${ovenId} state changed`);
      let oven = this.ovens.get(ovenId);
      if (!oven) {
        this.log.info(`Oven ${ovenId} not found, creating new`);
        const ovenName = this._pendingOvens.find((eachOven) => eachOven.cookerId === ovenId)?.name;
        oven = new AnovaOven(ovenId, ovenName || `Oven ${ovenId.substring(0, 4)}`, message.payload.state, this);
        this.ovens.set(ovenId, oven);
        this.emit('ovenFound', oven);
      }
      oven.curStateMessage = message.payload.state;
    } else if (message.command === 'RESPONSE') {
      this.log.info(`Received response to command ${message.requestId}`);
      this.emit('commandResponse', message);
    } else {
      this.log.warn(`Unknown message type received: ${(message as { command: string }).command}`);
      this.log.debug(JSON.stringify(message, null, 2));
    }
  }

  public async sendOvenCommand<T extends OvenCommand>(command: T['command'], payload: T['payload']) {
    const cmd = {
      command,
      payload,
      requestId: uuidv4(),
    };
    this.log.info(`Sending command ${cmd.requestId}`);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(`Timeout waiting for response to command ${cmd.requestId}`);
      }, 5000);

      const watchdog = (response: OvenCommandResponse) => {
        if (response.requestId === cmd.requestId) {
          this.off('commandResponse', watchdog);
          clearTimeout(timeout);

          if (response.payload.status === 'ok') {
            resolve();
          } else {
            this.log.error(`Command ${cmd.requestId} failed:`);
            this.log.error(JSON.stringify(response, null, 2));
            reject(`Command ${cmd.requestId} failed`);
          }
        }
      };
      this.on('commandResponse', watchdog);
      this._socket.send(JSON.stringify(cmd));
    });
  }
}
