import { Recipe } from './AnovaOvenService';

/** Recipe switches created when the config has no `recipes` entry (same as config.json.example). */
export const DEFAULT_RECIPES: Recipe[] = [
  {
    name: 'Make Toast',
    stages: [
      {
        title: 'Start Cook',
        type: 'cook',
        userActionRequired: true,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 250,
              fahrenheit: 482,
            },
          },
        },
        timer: {
          initial: 180,
        },
        heatingElements: {
          top: {
            on: true,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: false,
          },
        },
        fan: {
          speed: 0,
        },
        vent: {
          open: false,
        },
      },
      {
        title: 'Add Steam',
        type: 'cook',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 250,
              fahrenheit: 482,
            },
          },
        },
        steamGenerators: {
          mode: 'steam-percentage',
          steamPercentage: {
            setpoint: 100,
          },
        },
        timer: {
          initial: 240,
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: true,
          },
        },
        fan: {
          speed: 100,
        },
        vent: {
          open: false,
        },
      },
      {
        title: 'Cool Down',
        type: 'cook',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 25,
              fahrenheit: 77,
            },
          },
        },
        timer: {
          initial: 60,
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: true,
          },
          rear: {
            on: false,
          },
        },
        fan: {
          speed: 0,
        },
        vent: {
          open: false,
        },
      },
    ],
  },
  {
    name: 'Bake',
    stages: [
      {
        title: 'Pre-heat',
        type: 'preheat',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 176.67,
              fahrenheit: 350,
            },
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: true,
          },
          rear: {
            on: false,
          },
        },
        fan: {
          speed: 33,
        },
        vent: {
          open: false,
        },
      },
      {
        title: 'Bake',
        type: 'cook',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 176.67,
              fahrenheit: 350,
            },
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: true,
          },
          rear: {
            on: false,
          },
        },
        fan: {
          speed: 33,
        },
        vent: {
          open: false,
        },
      },
    ],
  },
  {
    name: 'Sous-Vide',
    stages: [
      {
        title: 'Pre-heat',
        type: 'preheat',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'wet',
          wet: {
            setpoint: {
              celsius: 54.44,
              fahrenheit: 130,
            },
          },
        },
        steamGenerators: {
          mode: 'relative-humidity',
          relativeHumidity: {
            setpoint: 100,
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: true,
          },
        },
        fan: {
          speed: 100,
        },
        vent: {
          open: false,
        },
      },
      {
        title: 'Sous Vide',
        type: 'cook',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'wet',
          wet: {
            setpoint: {
              celsius: 54.44,
              fahrenheit: 130,
            },
          },
        },
        steamGenerators: {
          mode: 'relative-humidity',
          relativeHumidity: {
            setpoint: 100,
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: true,
          },
        },
        fan: {
          speed: 100,
        },
        vent: {
          open: false,
        },
      },
    ],
  },
  {
    name: 'Air Fry',
    stages: [
      {
        title: 'Pre-heat',
        type: 'preheat',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 218.33,
              fahrenheit: 425,
            },
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: true,
          },
        },
        fan: {
          speed: 100,
        },
        vent: {
          open: false,
        },
      },
      {
        title: 'Air Fry',
        type: 'cook',
        userActionRequired: false,
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            setpoint: {
              celsius: 218.33,
              fahrenheit: 425,
            },
          },
        },
        heatingElements: {
          top: {
            on: false,
          },
          bottom: {
            on: false,
          },
          rear: {
            on: true,
          },
        },
        fan: {
          speed: 100,
        },
        vent: {
          open: false,
        },
      },
    ],
  },
];
