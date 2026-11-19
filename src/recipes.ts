import { Logger } from 'homebridge';
import { Recipe } from './AnovaOvenService';
import { StagesEntity, SteamGenerators, TemperatureBulbSetPoint } from './AnovaTypes';
import { DEFAULT_RECIPES } from './defaultRecipes';

/**
 * Cooking modes for recipes built from simple settings. Element and fan combinations come from
 * the Anova app's own recipes (Bake, Air Fry, Toast) and Anova's official developer examples (Roast, Steam, Sous Vide).
 */
export const COOKING_MODES = {
  bake: { label: 'Bake (bottom element, low fan)', top: false, bottom: true, rear: false, fan: 33, bulb: 'dry' },
  roast: { label: 'Roast / convection (bottom + rear, fan)', top: false, bottom: true, rear: true, fan: 75, bulb: 'dry' },
  airFry: { label: 'Air fry (rear element, full fan)', top: false, bottom: false, rear: true, fan: 100, bulb: 'dry' },
  broil: { label: 'Broil (top element, no fan)', top: true, bottom: false, rear: false, fan: 0, bulb: 'dry' },
  steam: { label: 'Steam (all elements + humidity)', top: true, bottom: true, rear: true, fan: 50, bulb: 'dry' },
  sousVide: { label: 'Sous vide (wet bulb, 100% humidity)', top: false, bottom: false, rear: true, fan: 100, bulb: 'wet' },
} as const;

export type CookingMode = keyof typeof COOKING_MODES;

export const DEFAULT_OVEN_MODE: CookingMode = 'roast';
export const DEFAULT_TEMPERATURE_F = 350;

/** Oven limits from Anova's docs: 25-250 °C dry bulb, wet bulb (sous vide) up to 100 °C. */
export const MIN_TEMP_C = 25;
export const MAX_DRY_TEMP_C = 250;
export const MAX_WET_TEMP_C = 100;

export const fToC = (f: number) => Math.round((f - 32) * 5 / 9 * 100) / 100;
export const cToF = (c: number) => Math.round(c * 9 / 5 + 32);

export const isCookingMode = (mode: unknown): mode is CookingMode =>
  typeof mode === 'string' && Object.prototype.hasOwnProperty.call(COOKING_MODES, mode);

export const clampTemperatureC = (celsius: number, mode: CookingMode) => {
  const max = COOKING_MODES[mode].bulb === 'wet' ? MAX_WET_TEMP_C : MAX_DRY_TEMP_C;
  return Math.min(max, Math.max(MIN_TEMP_C, celsius));
};

export type SimpleRecipeSettings = {
  mode: CookingMode;
  temperatureC: number;
  /** Steam mode: relative humidity %. Other dry modes: steam %. Ignored for sous vide (always 100% humidity). */
  steamPercent?: number;
  timerMinutes?: number;
  /** Add a preheat stage before the timed cook stage (default true). */
  preheat?: boolean;
};

/** Build Anova v1 cook stages (same field set as Anova's official examples) from simple settings. */
export function buildStages(settings: SimpleRecipeSettings): StagesEntity[] {
  const preset = COOKING_MODES[settings.mode];
  const celsius = clampTemperatureC(settings.temperatureC, settings.mode);
  const setpoint = { celsius: Math.round(celsius * 100) / 100, fahrenheit: cToF(celsius) };
  const temperatureBulbs: TemperatureBulbSetPoint = preset.bulb === 'wet'
    ? { mode: 'wet', wet: { setpoint } }
    : { mode: 'dry', dry: { setpoint } };

  let steamGenerators: SteamGenerators | undefined;
  const steam = Math.min(100, Math.max(0, Math.round(settings.steamPercent ?? 0)));
  if (settings.mode === 'sousVide') {
    steamGenerators = { mode: 'relative-humidity', relativeHumidity: { setpoint: 100 } };
  } else if (settings.mode === 'steam') {
    steamGenerators = { mode: 'relative-humidity', relativeHumidity: { setpoint: settings.steamPercent === undefined ? 100 : steam } };
  } else if (steam > 0) {
    steamGenerators = { mode: 'steam-percentage', steamPercentage: { setpoint: steam } };
  }

  const stage = (type: 'preheat' | 'cook', timerSeconds?: number): StagesEntity => ({
    stepType: 'stage',
    title: type === 'preheat' ? 'Preheat' : 'Cook',
    description: '',
    type,
    userActionRequired: false,
    temperatureBulbs,
    heatingElements: { top: { on: preset.top }, bottom: { on: preset.bottom }, rear: { on: preset.rear } },
    fan: { speed: preset.fan },
    vent: { open: false },
    rackPosition: 3,
    stageTransitionType: 'automatic',
    ...(steamGenerators ? { steamGenerators } : {}),
    ...(timerSeconds ? { timer: { initial: timerSeconds } } : {}),
  });

  const timerSeconds = settings.timerMinutes && settings.timerMinutes > 0 ? Math.round(settings.timerMinutes * 60) : undefined;
  const stages: StagesEntity[] = [];
  if (settings.preheat !== false) {
    stages.push(stage('preheat'));
  }
  stages.push(stage('cook', timerSeconds));
  return stages;
}

/** A recipe entry as it appears in the plugin config: either simple settings or raw Anova stages. */
export type RecipeConfig = {
  name?: unknown;
  stages?: unknown;
  mode?: unknown;
  temperatureF?: unknown;
  steamPercent?: unknown;
  timerMinutes?: unknown;
  preheat?: unknown;
};

const toNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** Turns one config entry into a Recipe, or returns an error message explaining why it was skipped. */
export function parseRecipe(entry: RecipeConfig): Recipe | string {
  if (typeof entry?.name !== 'string' || !entry.name.trim()) {
    return 'it needs a "name"';
  }
  const name = entry.name.trim();
  if (Array.isArray(entry.stages)) {
    return entry.stages.length ? { name, stages: entry.stages as StagesEntity[] } : `"${name}" has an empty "stages" list`;
  }
  const mode = entry.mode ?? DEFAULT_OVEN_MODE;
  if (!isCookingMode(mode)) {
    return `"${name}" has an unknown mode "${String(mode)}" (use one of ${Object.keys(COOKING_MODES).join(', ')})`;
  }
  const temperatureF = toNumber(entry.temperatureF);
  if (!Number.isFinite(temperatureF)) {
    return `"${name}" needs a temperature ("temperatureF")`;
  }
  const timerMinutes = toNumber(entry.timerMinutes);
  const steamPercent = toNumber(entry.steamPercent);
  return {
    name,
    stages: buildStages({
      mode,
      temperatureC: fToC(temperatureF),
      steamPercent: Number.isFinite(steamPercent) ? steamPercent : undefined,
      timerMinutes: Number.isFinite(timerMinutes) ? timerMinutes : undefined,
      preheat: entry.preheat !== false,
    }),
  };
}

export const DEFAULT_RECIPE_NAMES = DEFAULT_RECIPES.map((r) => r.name);

/**
 * The recipe switches to create: the selected built-in recipes plus the user's own.
 * A user recipe with the same name as a built-in one replaces it.
 */
export function resolveRecipes(config: { recipes?: unknown; defaultRecipes?: unknown }, log: Logger): Recipe[] {
  let defaults = DEFAULT_RECIPES;
  if (Array.isArray(config.defaultRecipes)) {
    const wanted = new Set(config.defaultRecipes.filter((n): n is string => typeof n === 'string'));
    defaults = DEFAULT_RECIPES.filter((r) => wanted.has(r.name));
  } else if (config.defaultRecipes !== undefined) {
    log.warn('"defaultRecipes" should be a list of built-in recipe names; showing all of them.');
  }

  const custom: Recipe[] = [];
  if (Array.isArray(config.recipes)) {
    config.recipes.forEach((entry, idx) => {
      const e = entry as RecipeConfig;
      // The settings form starts with one blank row (only its defaults filled in); ignore it quietly.
      if (e && typeof e === 'object' && !e.name && e.temperatureF === undefined && e.stages === undefined) {
        return;
      }
      const parsed = parseRecipe(e);
      if (typeof parsed === 'string') {
        log.warn(`Skipping recipe #${idx + 1}: ${parsed}.`);
      } else {
        custom.push(parsed);
      }
    });
  } else if (config.recipes !== undefined) {
    log.error('"recipes" in the plugin config must be a list; ignoring it.');
  }

  const customNames = new Set(custom.map((r) => r.name));
  return [...defaults.filter((r) => !customNames.has(r.name)), ...custom];
}

/**
 * Stages that keep the heating setup of `stage` (elements, fan, steam, wet/dry) at a new temperature.
 * Used when the temperature is changed mid-cook, since the token API can only start and stop cooks.
 * A running timer carries over as `remainingTimerSeconds`.
 */
export function retargetStages(stage: StagesEntity, celsius: number, remainingTimerSeconds?: number): StagesEntity[] {
  const wet = stage.temperatureBulbs?.mode === 'wet';
  const clamped = Math.min(wet ? MAX_WET_TEMP_C : MAX_DRY_TEMP_C, Math.max(MIN_TEMP_C, celsius));
  const setpoint = { celsius: Math.round(clamped * 100) / 100, fahrenheit: cToF(clamped) };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, timer, ...rest } = stage;
  const base: StagesEntity = {
    ...rest,
    stepType: 'stage',
    description: '',
    userActionRequired: false,
    stageTransitionType: 'automatic',
    temperatureBulbs: wet ? { mode: 'wet', wet: { setpoint } } : { mode: 'dry', dry: { setpoint } },
  };
  const cook: StagesEntity = { ...base, type: 'cook', title: 'Cook' };
  if (remainingTimerSeconds && remainingTimerSeconds > 0) {
    cook.timer = { initial: Math.round(remainingTimerSeconds) };
  }
  return [{ ...base, type: 'preheat', title: 'Preheat' }, cook];
}
