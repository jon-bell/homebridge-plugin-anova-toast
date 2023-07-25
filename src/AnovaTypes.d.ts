export type AnovaOvenEvent = {
    setName: (newName: string) => void;
    ovenState: (update: OvenStateMessage) => void;
    cookStart: (cook: OvenStateMessage['cook']) => void;
    cookEnd: () => void;
};
export type DeviceID = string;

export type OvenResponse = OvenCommandResponse | OvenStateResponse | APOWifiListResponse;

export type APOWifiListResponse = {
    command: 'EVENT_APO_WIFI_LIST';
    payload: {
        cookerId: DeviceID;
        name: string;
        pairedAt: string;
        type: string;
    }[];
};
export type OvenCommandResponse = {
    command: 'RESPONSE';
    requestId: string;
    payload: {
        status: string; //current known status is only 'ok'
    };
};
export type OvenStateResponse = {
    command: 'EVENT_APO_STATE';
    payload: {
        cookerId: DeviceID;
        state: OvenStateMessage;
        type: string;
    };
};
export interface OvenStateMessage {
    version: number;
    updatedTimestamp: string;
    systemInfo: SystemInfo;
    state: OvenState;
    nodes: Nodes;
    cook?: { cookId: string; stages: StagesEntity[] };
}
export interface SystemInfo {
    online: boolean;
    hardwareVersion: string;
    powerMains: number;
    powerHertz: number;
    firmwareVersion: string;
    uiHardwareVersion: string;
    uiFirmwareVersion: string;
    firmwareUpdatedTimestamp: string;
    lastConnectedTimestamp: string;
    lastDisconnectedTimestamp: string;
    triacsFailed: boolean;
}
export interface OvenState {
    mode: 'cook' | 'idle';
    temperatureUnit: string;
    processedCommandIds?: (string)[] | null;
}
export interface Nodes {
    temperatureBulbs: TemperatureBulbs;
    timer: Timer;
    temperatureProbe: TemperatureProbe;
    steamGenerators: SteamGenerators;
    heatingElements: HeatingElements;
    fan: Fan;
    vent: Vent;
    waterTank: WaterTank;
    door: Door;
    lamp: Lamp;
    userInterfaceCircuit: UserInterfaceCircuit;
}
export interface TemperatureBulbs {
    mode: string;
    wet: WetStatus;
    dry: DryStatus;
    dryTop: DryTopOrDryBottomStatus;
    dryBottom: DryTopOrDryBottomStatus;
}
export interface WetStatus {
    current: CurrentOrSetpoint;
    dosed: boolean;
    doseFailed: boolean;
}
export interface CurrentOrSetpoint {
    celsius: number;
    fahrenheit: number;
}
export interface DryStatus {
    current: CurrentOrSetpoint;
    setpoint: CurrentOrSetpoint;
}
export interface DryTopOrDryBottomStatus {
    current: CurrentOrSetpoint;
    overheated: boolean;
}
export interface Timer {
    mode: string;
    initial: number;
    current: number;
}
export interface TemperatureProbe {
    connected: boolean;
}
export interface SteamGenerators {
    mode: string;
    relativeHumidity?: RelativeHumidity;
    evaporator?: Evaporator;
    boiler?: Boiler;
    steamPercentage?: SetpointNumber;
}
export interface RelativeHumidity {
    current?: number;
    setpoint: number;
}
export interface Evaporator {
    failed: boolean;
    overheated: boolean;
    celsius: number;
    watts: number;
}
export interface Boiler {
    descaleRequired: boolean;
    failed: boolean;
    overheated: boolean;
    celsius: number;
    watts: number;
    dosed: boolean;
}
export interface HeatingElements {
    top: HeatingElement;
    bottom: HeatingElement;
    rear: HeatingElement;
}
export interface HeatingElement {
    on: boolean;
    failed?: boolean;
    watts?: number;
}
export interface Fan {
    speed: number;
    failed?: boolean;
}
export interface Vent {
    open: boolean;
}
export interface WaterTank {
    empty: boolean;
}
export interface Door {
    closed: boolean;
}
export interface Lamp {
    on: boolean;
    failed: boolean;
    preference: string;
}
export interface UserInterfaceCircuit {
    communicationFailed: boolean;
}

export type OvenCommand = StartCookCommand | StopCookCommand;

export interface StopCookCommand {
    requestId: string;
    command: 'CMD_APO_STOP';
    payload: {
        'type': 'CMD_APO_STOP';
        'id': DeviceID;
    };
}
export interface StartCookCommand {
    requestId: string;
    command: 'CMD_APO_START';
    payload: {
        payload: StartCookPayload;
        type: 'CMD_APO_START';
        id: DeviceID;
    };
}
export interface StartCookPayload {
    cookId: string;
    stages: StagesEntity[];
}
export interface StagesEntity {
    stepType?: 'stage';
    id: string;
    title: string;
    description?: string;
    type: 'preheat' | 'cook';
    userActionRequired: boolean;
    timer?: { initial: number };
    temperatureBulbs: TemperatureBulbSetPoint;
    heatingElements: HeatingElements;
    fan: Fan;
    vent: Vent;
    rackPosition?: number;
    steamGenerators?: SteamGenerators;
}
export type TemperatureBulbSetPoint = WetBulbSpec | DryBulbSpec;
export interface DryBulbSpec {
    dry: { setpoint: Setpoint };
    mode: 'dry';
}
export interface WetBulbSpec {
    wet: { setpoint: Setpoint };
    mode: 'wet';
}
export interface WetStatus {
    setpoint: Setpoint;
}
export interface SetpointNumber {
    setpoint: number;
}
export interface Setpoint {
    fahrenheit: number;
    celsius: number;
}
export interface HeatingElements {
    top: HeatingElement;
    bottom: HeatingElement;
    rear: HeatingElement;
}
export interface HeatingElement {
    on: boolean;
}
export interface Fan {
    speed: number;
}
export interface Vent {
    open: boolean;
}
