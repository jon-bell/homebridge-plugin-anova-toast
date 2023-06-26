# Anova Precision Oven Homebridge Plugin
What if making toast were as easy as pushing a single button, or, that failing, a siri command away?

This Homebridge plugin implements the [Anova Precision Oven API](https://mcolyer.github.io/anova-oven-api/#introduction) to interface with the Anova cloud service (it does not locally connect to the oven - nobody has reverse-engineered a solution for that yet).

For each oven in your account, it exposes a device with multiple switches - one that toggles power on/off, and one for each of a list of favorite recipes. Toggling a recipe on starts that recipe. 

To install: see the `config.json.example` file. Copy/paste the "AnovaToast" platform definision into your `platforms` array. To customize the favorite recipes that show up in HomeKit, tweak the `recipes` block. 

Default recipes:
* Make toast (from the recipe in the Anova app)
* Bake (350F, bottom heater, low fan)
* Sous-Vide (130F, sous-video mode)
* Air Fry (425F, rear heater)

This plugin was created based on the code in [create new repository from template](https://github.com/homebridge/homebridge-plugin-template/generate)

©2023 Jonathan Bell, released under the Apache License 2.0