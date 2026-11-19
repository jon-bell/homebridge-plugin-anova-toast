import axios from 'axios';
import EventEmitter from 'events';
import TypedEventEmitter from 'typed-emitter';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import {
  AnovaOvenEvent, DeviceID, OvenCommand, OvenCommandResponse, OvenResponse, OvenStateMessage,
  StagesEntity, SteamGenerators, TemperatureBulbSetPoint,
} from './AnovaTypes';
import { Logger } from 'homebridge';

const DEFAULT_WEBSOCKET_URL = 'wss://devices.anovaculinary.io/';
const DEFAULT_AUTH_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCGJwHXUhkNBdPkH3OAkjc9-3xMMjvanfU';

/** How long to wait after opening the socket for Anova to send the oven list. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long to wait for Anova to acknowledge a command. */
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_ATTEMPTS = 3;
/** Keep-alive ping interval. */
const PING_INTERVAL_MS = 30_000;
/** If nothing at all arrives for this long, assume the socket is dead and reconnect. */
const STALE_CONNECTION_MS = 10 * 60_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
/**
 * Only reset the backoff once a connection has stayed up this long, so that a server that accepts and then
 * immediately drops us (e.g. Anova's rate limiting) doesn't cause a tight reconnect loop.
 */
const STABLE_CONNECTION_MS = 60_000;

/** Firebase error codes that mean the configured credentials are wrong (retrying won't help). */
const BAD_CREDENTIAL_CODES = [
  'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_EMAIL',
  'MISSING_PASSWORD', 'MISSING_EMAIL', 'USER_DISABLED',
];

/** Temperatures reported back by the oven may be rounded differently from the configured recipe. */
const TEMPERATURE_TOLERANCE_C = 0.1;

export class AuthenticationError extends Error { }
export class CommandRejectedError extends Error { }
export class CommandTimeoutError extends Error { }
export class NotConnectedError extends Error { }

const describeError = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    const code = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    return code ? `${e.message} (${code})` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

const steamGeneratorsEqual = (a: SteamGenerators | undefined, b: SteamGenerators | undefined) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b || a.mode !== b.mode) {
    return false;
  }
  if (a.mode === 'steam-percentage') {
    return a.steamPercentage?.setpoint === b.steamPercentage?.setpoint;
  }
  if (a.mode === 'relative-humidity') {
    return a.relativeHumidity?.setpoint === b.relativeHumidity?.setpoint;
  }
  // Unknown steam mode: treat matching modes as equal rather than throwing inside a HomeKit read.
  return true;
};

const temperaturesEqual = (a: number | undefined, b: number | undefined) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= TEMPERATURE_TOLERANCE_C;

const temperatureBulbsEqual = (a: TemperatureBulbSetPoint | undefined, b: TemperatureBulbSetPoint | undefined) => {
  if (!a || !b || a.mode !== b.mode) {
    return false;
  }
  if (a.mode === 'dry' && b.mode === 'dry') {
    return temperaturesEqual(a.dry?.setpoint?.celsius, b.dry?.setpoint?.celsius);
  }
  if (a.mode === 'wet' && b.mode === 'wet') {
    return temperaturesEqual(a.wet?.setpoint?.celsius, b.wet?.setpoint?.celsius);
  }
  return false;
};

const stagesEqual = (stage1: StagesEntity, stage2: StagesEntity) => {
  return stage1.fan?.speed === stage2.fan?.speed &&
    stage1.heatingElements?.bottom?.on === stage2.heatingElements?.bottom?.on &&
    stage1.heatingElements?.rear?.on === stage2.heatingElements?.rear?.on &&
    stage1.heatingElements?.top?.on === stage2.heatingElements?.top?.on &&
    steamGeneratorsEqual(stage1.steamGenerators, stage2.steamGenerators) &&
    temperatureBulbsEqual(stage1.temperatureBulbs, stage2.temperatureBulbs) &&
    stage1.vent?.open === stage2.vent?.open;
};

export class AnovaOven extends (EventEmitter as new () => TypedEventEmitter<AnovaOvenEvent>) {
  private _name: string;
  private _state: OvenStateMessage;

  public constructor(
    public readonly deviceId: DeviceID,
    name: string,
    startingState: OvenStateMessage,
    private readonly service: AnovaOvenService,
  ) {
    super();
    this._name = name;
    this._state = startingState;
  }

  public set name(name: string) {
    if (name === this._name) {
      return;
    }
    this._name = name;
    this.emit('setName', name);
  }

  public get name() {
    return this._name;
  }

  /** Apply a state update received from the Anova cloud. */
  public updateState(update: OvenStateMessage) {
    const prev = this._state;
    this._state = update;
    if (update.state?.mode !== prev.state?.mode) {
      this.service.log.info(`Oven ${this.deviceId} is in state ${update.state?.mode}`);
    }
    this.emit('ovenState', update);
    if (update.cook && !prev.cook) {
      this.service.log.info(`Oven ${this.deviceId} started cooking`);
      this.emit('cookStart', update.cook);
    } else if (prev.cook && !update.cook) {
      this.service.log.info(`Oven ${this.deviceId} stopped cooking`);
      this.emit('cookEnd');
    }
  }

  /** True while the oven is running any cook (from HomeKit, the app, or the oven's own controls). */
  public get isOn(): boolean {
    return Boolean(this._state.cook);
  }

  public get state(): OvenStateMessage {
    return this._state;
  }

  public async stopCook() {
    await this.service.sendOvenCommand('CMD_APO_STOP', {
      type: 'CMD_APO_STOP',
      id: this.deviceId,
    });
    if (this._state.cook) {
      this._state = { ...this._state, cook: undefined };
      this.emit('cookEnd');
    }
  }

  /**
   * Start a cook with the given stages. Stages without an ID get a fresh UUID; the caller's
   * objects are not modified. Returns the cook ID.
   */
  public async startCook(stages: StagesEntity[]) {
    const cookStages = stages.map((stage) => ({ ...stage, id: stage.id || uuidv4() }));
    const cookId = uuidv4();
    await this.service.sendOvenCommand('CMD_APO_START', {
      payload: { cookId, stages: cookStages },
      type: 'CMD_APO_START',
      id: this.deviceId,
    });
    return cookId;
  }

  /**
   * Returns true if the currently active cook has the same stages (compares settings, not stage or cook IDs)
   */
  public isCooking(stages: StagesEntity[]) {
    const curCook = this._state?.cook;
    if (!curCook?.stages || curCook.stages.length !== stages.length) {
      return false;
    }
    return stages.every((v, idx) => stagesEqual(v, curCook.stages[idx]));
  }
}

export type AnovaOvenServiceEvents = {
  connected: () => void;
  disconnected: () => void;
  ovenFound: (oven: AnovaOven) => void;
  commandResponse: (response: OvenCommandResponse) => void;
};

export type Recipe = {
  name: string;
  stages: StagesEntity[];
};

export type AnovaOvenServiceOptions = {
  /** Anova personal access token (starts with "anova-"). Preferred over email/password when set. */
  token?: string;
  email?: string;
  password?: string;
  /** Overrides for local development/testing against a mock server. */
  websocketUrl?: string;
  authUrl?: string;
};

/**
 * Maintains a single WebSocket connection to the Anova cloud, reconnecting with backoff when it drops.
 */
export default class AnovaOvenService extends (EventEmitter as new () => TypedEventEmitter<AnovaOvenServiceEvents>) {
  public readonly ovens: Map<DeviceID, AnovaOven> = new Map();

  private socket?: WebSocket;
  private connected = false;
  private running = false;
  private connecting = false;
  private credentialsRejected = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private readonly ovenNames = new Map<DeviceID, string>();

  public constructor(private readonly options: AnovaOvenServiceOptions, public readonly log: Logger) {
    super();
    // One listener per in-flight command or waiter; avoid spurious leak warnings.
    this.setMaxListeners(50);
  }

  public get isConnected() {
    return this.connected && this.socket?.readyState === WebSocket.OPEN;
  }

  /** Connect and stay connected until stop() is called. */
  public start() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.connect();
  }

  public stop() {
    this.running = false;
    this.clearReconnectTimer();
    this.clearConnectionTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (socket) {
      socket.removeAllListeners('message');
      socket.on('error', () => undefined);
      socket.terminate();
    }
  }

  /** Builds the URL (including credentials) and subprotocols used to open the socket. */
  protected async getConnectionParameters(): Promise<{ url: string; protocols?: string[] }> {
    const base = this.options.websocketUrl ?? DEFAULT_WEBSOCKET_URL;
    if (this.options.token) {
      // Official developer API: https://developer.anovaculinary.com/docs/devices/wifi/authentication
      return {
        url: `${base}?token=${encodeURIComponent(this.options.token)}&supportedAccessories=APO`,
      };
    }
    const token = await this.getFirebaseToken();
    return {
      url: `${base}?token=${encodeURIComponent(token)}&supportedAccessories=APO&platform=android`,
      protocols: ['ANOVA_V2'],
    };
  }

  private async getFirebaseToken(): Promise<string> {
    try {
      const { data } = await axios({
        method: 'post',
        url: this.options.authUrl ?? DEFAULT_AUTH_URL,
        headers: { 'content-type': 'application/json' },
        timeout: 15_000,
        data: {
          email: this.options.email,
          password: this.options.password,
          returnSecureToken: true,
        },
      });
      return data.idToken;
    } catch (e) {
      const code = axios.isAxiosError(e)
        ? (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message
        : undefined;
      if (code && BAD_CREDENTIAL_CODES.some((bad) => code.startsWith(bad))) {
        throw new AuthenticationError(`Anova rejected the email/password (${code}).`);
      }
      throw e;
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting || this.socket) {
      return;
    }
    this.connecting = true;
    this.clearReconnectTimer();

    let params: { url: string; protocols?: string[] };
    try {
      params = await this.getConnectionParameters();
    } catch (e) {
      this.connecting = false;
      if (e instanceof AuthenticationError) {
        this.credentialsRejected = true;
        this.log.error(`${e.message} Fix the credentials in the plugin settings and restart Homebridge.`);
        return;
      }
      this.log.warn(`Could not sign in to Anova: ${describeError(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    if (!this.running) {
      return;
    }

    const socket = new WebSocket(params.url, params.protocols);
    this.socket = socket;
    let lastError: Error | undefined;

    const connectTimeout = setTimeout(() => {
      this.log.warn('Timed out waiting for the Anova cloud to respond; reconnecting');
      socket.terminate();
    }, CONNECT_TIMEOUT_MS);

    socket.on('open', () => {
      this.log.debug('WebSocket open, waiting for oven list');
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.ping();
        }
      }, PING_INTERVAL_MS);
      this.resetStaleTimer(socket);
    });

    socket.on('message', (raw) => {
      if (socket !== this.socket) {
        return;
      }
      this.resetStaleTimer(socket);
      let message: OvenResponse;
      try {
        message = JSON.parse(raw.toString()) as OvenResponse;
      } catch {
        this.log.warn('Ignoring a message from Anova that was not valid JSON');
        return;
      }
      if (message.command === 'EVENT_APO_WIFI_LIST' && !this.connected) {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.stableTimer = setTimeout(() => {
          this.reconnectAttempts = 0;
        }, STABLE_CONNECTION_MS);
        this.log.info('Connected to the Anova cloud');
        this.emit('connected');
      }
      this.dispatch(message);
    });

    // Without an 'error' listener, ws re-throws and takes down the whole Homebridge process.
    socket.on('error', (err) => {
      lastError = err;
      this.log.warn(`Anova connection error: ${err.message}`);
    });

    socket.on('close', (code, reason) => {
      clearTimeout(connectTimeout);
      if (socket !== this.socket) {
        return;
      }
      this.socket = undefined;
      this.clearConnectionTimers();
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) {
        const why = reason?.length ? `: ${reason.toString()}` : '';
        this.log.warn(`Disconnected from the Anova cloud (code ${code}${why})`);
        this.emit('disconnected');
      }
      if (lastError && /Unexpected server response: 40[13]/.test(lastError.message)) {
        this.credentialsRejected = true;
        this.log.error('Anova refused the connection (not authorized). Check the credentials in the plugin settings '
          + 'and restart Homebridge.');
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (!this.running || this.reconnectTimer || this.credentialsRejected) {
      return;
    }
    const backoff = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts);
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts++;
    this.log.info(`Reconnecting to the Anova cloud in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  /** Skip any pending backoff and reconnect right away (used when the user is actively waiting on a command). */
  private reconnectNow() {
    if (this.connected || this.connecting || this.socket || this.credentialsRejected) {
      return;
    }
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    void this.connect();
  }

  private resetStaleTimer(socket: WebSocket) {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
    }
    this.staleTimer = setTimeout(() => {
      this.log.warn(`No messages from Anova for ${STALE_CONNECTION_MS / 60_000} minutes; reconnecting`);
      socket.terminate();
    }, STALE_CONNECTION_MS);
  }

  private clearConnectionTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private dispatch(message: OvenResponse) {
    if (message.command === 'EVENT_APO_WIFI_LIST') {
      message.payload.forEach((oven) => {
        this.ovenNames.set(oven.cookerId, oven.name);
        const existingOven = this.ovens.get(oven.cookerId);
        if (existingOven) {
          existingOven.name = oven.name;
        }
      });
    } else if (message.command === 'EVENT_APO_STATE') {
      const ovenId = message.payload.cookerId;
      this.log.debug(`Oven ${ovenId} state update`);
      let oven = this.ovens.get(ovenId);
      if (!oven) {
        this.log.info(`Found oven ${ovenId}`);
        const name = this.ovenNames.get(ovenId) || `Oven ${ovenId.substring(0, 4)}`;
        oven = new AnovaOven(ovenId, name, message.payload.state, this);
        this.ovens.set(ovenId, oven);
        this.emit('ovenFound', oven);
      }
      oven.updateState(message.payload.state);
    } else if (message.command === 'RESPONSE') {
      this.log.debug(`Received response to command ${message.requestId}`);
      this.emit('commandResponse', message);
    } else if (message.command === 'EVENT_USER_STATE') {
      // ignore
    } else {
      this.log.debug(`Ignoring message type ${(message as { command: string }).command}`);
    }
  }

  private waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.isConnected) {
      return Promise.resolve();
    }
    if (!this.running || this.credentialsRejected) {
      return Promise.reject(new NotConnectedError('Not connected to the Anova cloud'));
    }
    this.reconnectNow();
    return new Promise((resolve, reject) => {
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new NotConnectedError('Timed out waiting to connect to the Anova cloud'));
      }, timeoutMs);
      this.once('connected', onConnected);
    });
  }

  /**
   * Send a command, waiting for a connection if needed. Retries on timeouts and dropped connections,
   * but not when Anova explicitly rejects the command.
   */
  public async sendOvenCommand<T extends OvenCommand>(command: T['command'], payload: T['payload']) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= COMMAND_ATTEMPTS; attempt++) {
      try {
        await this.waitUntilConnected(CONNECT_TIMEOUT_MS + 5_000);
        await this.sendOnce(command, payload);
        return;
      } catch (e) {
        lastError = e;
        if (e instanceof CommandRejectedError || this.credentialsRejected || !this.running) {
          break;
        }
        this.log.warn(`${command} attempt ${attempt} of ${COMMAND_ATTEMPTS} failed: ${describeError(e)}`);
        if (e instanceof CommandTimeoutError) {
          // The socket may be half-dead; force a fresh connection before retrying.
          this.socket?.terminate();
        }
      }
    }
    throw lastError;
  }

  private sendOnce<T extends OvenCommand>(command: T['command'], payload: T['payload']) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new NotConnectedError('Not connected to the Anova cloud'));
    }
    const cmd = {
      command,
      payload,
      requestId: uuidv4(),
    };
    this.log.debug(`Sending command ${JSON.stringify(cmd)}`);
    return new Promise<void>((resolve, reject) => {
      const onResponse = (response: OvenCommandResponse) => {
        if (response.requestId !== cmd.requestId) {
          return;
        }
        cleanup();
        if (response.payload?.status === 'ok') {
          resolve();
        } else {
          this.log.error(`Anova rejected ${command}: ${JSON.stringify(response.payload)}`);
          reject(new CommandRejectedError(`Anova rejected ${command}`));
        }
      };
      const onDisconnected = () => {
        cleanup();
        reject(new NotConnectedError('Connection to the Anova cloud dropped before the command was acknowledged'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new CommandTimeoutError(`Timed out waiting for Anova to acknowledge ${command}`));
      }, COMMAND_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('commandResponse', onResponse);
        this.off('disconnected', onDisconnected);
      };
      this.on('commandResponse', onResponse);
      this.on('disconnected', onDisconnected);
      socket.send(JSON.stringify(cmd), (err) => {
        if (err) {
          cleanup();
          reject(new NotConnectedError(`Could not send ${command}: ${err.message}`));
        }
      });
    });
  }
}
