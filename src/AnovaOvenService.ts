import axios from 'axios';
import EventEmitter from 'events';
import pino from 'pino';
import TypedEventEmitter from 'typed-emitter';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import {
  AnovaOvenResponse, DeviceID, OvenCommand, OvenCommandRequest, OvenCommandResponse, OvenStateMessage,
  OvenStateResponse, StagesEntity, StartCookPayload, SteamGenerators, TemperatureBulbSetPoint,
} from './AnovaTypes';

const logger = pino({ level: 'info' });

const steamGeneratorsEqual = (a: SteamGenerators | undefined, b: SteamGenerators | undefined) =>{
  if(!a && !b) {
    return true;
  }
  if(!a || !b){
    return false;
  }
  if(a.mode !== b.mode){
    return false;
  }
  if(a.mode === 'steam-percentage'){
    return a.steamPercentage?.setpoint === b.steamPercentage?.setpoint;
  }else{
    throw `Unknown steam mode ${a.mode}`;
  }
};
const temperatureBulbsEqual = (a: TemperatureBulbSetPoint, b: TemperatureBulbSetPoint) => {
  if(a.mode !== b.mode){
    return false;
  }
  if(a.mode === 'dry' && b.mode === 'dry'){
    return a.dry.setpoint.celsius === b.dry.setpoint.celsius;
  } else{
    throw `Unknown temp bulb mode ${a.mode}`;
  }
};
const stagesEqual = (stage1: StagesEntity, stage2: StagesEntity)=>{
  return stage1.fan.speed === stage2.fan.speed &&
  stage1.heatingElements.bottom.on === stage2.heatingElements.bottom.on&&
  stage1.heatingElements.rear.on === stage2.heatingElements.rear.on &&
  stage1.heatingElements.top.on === stage2.heatingElements.top.on &&
  steamGeneratorsEqual(stage1.steamGenerators, stage2.steamGenerators) &&
  temperatureBulbsEqual(stage1.temperatureBulbs, stage2.temperatureBulbs) &&
  stage1.vent.open === stage2.vent.open;
};

export class AnovaOven extends (EventEmitter as new () => TypedEventEmitter<AnovaOvenResponse>) {
  private _id: DeviceID;
  private _curStateMessage: OvenStateMessage;
  private _service: AnovaOvenService;

  public constructor(id: DeviceID, startingState: OvenStateMessage, service: AnovaOvenService) {
    super();
    this._id = id;
    this.on('ovenState', (update) => {
      this._curStateMessage = update;
    });
    this._curStateMessage = startingState;
    this._service = service;
  }

  public set curStateMessage(update: OvenStateMessage) {
    this.emit('ovenState', update);
    if (update.state.mode !== this._curStateMessage.state.mode) {
      logger.info(`Oven ${this._id} is in state ${update.state.mode}`);
    }
    logger.trace(JSON.stringify(update, null, 2));
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

  private async _sendOvenCommand(command: OvenCommand) {
    const cmd: OvenCommandRequest = {
      command: 'SEND_OVEN_COMMAND',
      payload: {
        deviceId: this._id,
        requestId: uuidv4(),
        command: command,
      },
    };
    logger.info(`Sending command ${cmd.payload.requestId}`);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(`Timeout waiting for response to command ${cmd.payload.requestId}`);
      }, 5000);

      const watchdog = (response) => {
        if (response.requestId === cmd.payload.requestId) {
          this._service.off('commandResponse', watchdog);
          clearTimeout(timeout);

          if (response.success) {
            resolve();
          } else {
            logger.error(`Command ${cmd.payload.requestId} failed:`);
            logger.error(JSON.stringify(response, null, 2));
            reject(`Command ${cmd.payload.requestId} failed`);
          }
        }
      };
      this._service.on('commandResponse', watchdog);
      this._service.send(cmd);
    });
  }

  private async _startCook(payload: StartCookPayload) {
    await this._sendOvenCommand({ id: uuidv4(), type: 'startCook', payload: payload });
  }

  public async stopCook() {
    await this._sendOvenCommand({ id: uuidv4(), type: 'stopCook' });
  }

  /**
   * Convenience method for starting a cook givnen a set of stages.
   * Ensures that a UUID is set on each stage
   * Returns the cook ID
   *
   * @param stages
   */
  public async startCook(stages: StagesEntity[]){
    stages.forEach(eachStage => {
      if(!eachStage.id) {
        eachStage.id = uuidv4();
      }
    });
    const cookId = uuidv4();
    await this._startCook({cookId, stages});
    return cookId;
  }

  /**
   * Returns true if the currently active cook has the same stages (by object equality, does not rely on stage ID or cook ID)
   * @param stages
   */
  public isCooking(stages: StagesEntity[]){
    const curCook = this._curStateMessage.cook;
    if(!curCook){
      return false;
    }
    if(curCook.stages.length !== stages.length){
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
  public readonly ovens: Map<DeviceID, AnovaOven> = new Map();

  public constructor(args: { email: string; password: string }) {
    super();
    this._email = args.email;
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
      this._socket = new WebSocket('wss://app.oven.anovaculinary.io');

      //once opened, authenticate
      this._socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.response === 'AUTH_TOKEN_RESPONSE') {
          this.emit('authenticated');
        } else {
          this._dispatchToOven(message);
        }
      });

      this._socket.on('open', () => {
        logger.info('socket open');
        this._socket.send(JSON.stringify({ command: 'AUTH_TOKEN', payload: data.idToken }));
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

  private _dispatchToOven(message: { response: string; ovenId?: DeviceID; deviceId?: DeviceID }) {
    const ovenId = message.ovenId || message.deviceId;
    if (!ovenId) {
      logger.error('Message without ovenId received');
      logger.error(JSON.stringify(message, null, 2));
      return;
    }
    logger.info(`Message for oven ${ovenId} ${message.response}`);
    if (message.response === 'OVEN_STATE') {
      const stateMessage = message as OvenStateResponse;
      let oven = this.ovens.get(ovenId);
      if (!oven) {
        oven = new AnovaOven(ovenId, stateMessage.data, this);
        this.ovens.set(ovenId, oven);
        this.emit('ovenFound', oven);
      }
      oven.curStateMessage = stateMessage.data;
    } else if (message.response === 'OVEN_COMMAND_RESPONSE') {
      this.emit('commandResponse', message as OvenCommandResponse);
    } else {
      logger.debug('Unknown message type received');
      logger.debug(JSON.stringify(message, null, 2));
    }
  }

  public send(message: OvenCommandRequest): void {
    this._socket.send(JSON.stringify(message));
  }

}
