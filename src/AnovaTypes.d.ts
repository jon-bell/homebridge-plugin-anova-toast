export type AnovaOvenResponse = {
    ovenState: (update: OvenStateMessage) => void;
};
export type DeviceID = string;

export type OvenCommandResponse = {
    response: 'OVEN_COMMAND_RESPONSE';
    requestId: string;
    deviceId: DeviceID;
    success: boolean;
    data: object[];
};
export type OvenStateResponse = {
    response: 'OVEN_STATE';
    ovenId: DeviceID;
    data: OvenStateMessage;
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
    current: number;
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

export type OvenCommandRequest = {
    command: string;
    payload: {
        deviceId: DeviceID;
        requestId: string;
        command: OvenCommand;
    };
};
export type OvenCommand = StartCookCommand | StopCookCommand;
export type OvenPayload = StartCookPayload;
export interface StopCookCommand {
    id: string;
    type: 'stopCook';
}
export interface StartCookCommand {
    id: string;
    type: 'startCook';
    payload: StartCookPayload;
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
