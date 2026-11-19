# Anova Precision Oven Homebridge Plugin
What if making toast were as easy as pushing a single button, or, that failing, a siri command away?

This Homebridge plugin uses the [Anova developer API](https://developer.anovaculinary.com/docs/devices/wifi/overview) (or, with email/password, the [reverse-engineered app API](https://mcolyer.github.io/anova-oven-api/#introduction)) to interface with the Anova cloud service (it does not locally connect to the oven - nobody has reverse-engineered a solution for that yet).

For each oven in your account, it exposes a device with multiple switches - one that toggles power on/off, and one for each of a list of favorite recipes. Toggling a recipe on starts that recipe. 

To install: install the plugin from the Homebridge UI, then on the plugin's settings page paste an Anova personal access token. If you edit `config.json` by hand instead, see `config.json.example` and copy the "AnovaToast" platform definition into your `platforms` array.

### Signing in
Anova now offers [personal access tokens](https://developer.anovaculinary.com/docs/devices/wifi/personal-access-tokens) for its official developer API. To create one, open the Anova Oven app and go to More → Developer → Personal Access Tokens, then create a token (it starts with `anova-`). Put it in the `token` setting. A token means your Anova password doesn't have to be stored in your Homebridge config, and it works for accounts that sign in with Apple or Google.

Signing in with `email` and `password` (the unofficial method this plugin used originally) still works and is used when no token is set.

The token can only start and stop cooks, which is all this plugin does. Anova rate-limits token connections for personal use, so this plugin keeps a single connection open rather than reconnecting for each command. This plugin supports the first-generation Precision Oven; the Precision Oven 2.0 uses a different command format that hasn't been added yet.

The "Power On" switch is on whenever the oven is cooking anything (however the cook was started); turning it on starts a 350°F bake, and turning it off stops the oven. Each recipe switch is on while that recipe is the active cook.

To customize the favorite recipes that show up in HomeKit, add a `recipes` block to the platform config (see `config.json.example`). Recipes you remove from the list are removed from HomeKit. If there is no `recipes` block, these default recipes are used:
* Make toast (from the recipe in the Anova app)
* Bake (350F, bottom heater, low fan)
* Sous-Vide (130F, sous-video mode)
* Air Fry (425F, rear heater)

This plugin was created based on the code in [create new repository from template](https://github.com/homebridge/homebridge-plugin-template/generate)

## Release notes
- Unreleased:
  - New: sign in with an Anova personal access token (`token`), using Anova's official developer API. Email/password sign-in still works.
  - Fix: configuring the plugin from the Homebridge UI now works (the settings form used the wrong platform name, and a config without `recipes` crashed the plugin). The default recipes listed above are now actually used when no `recipes` are configured.
  - Fix: connection errors (Wi-Fi drop, DNS failure, Anova outage) and failed logins no longer crash Homebridge.
  - Fix: the connection to the Anova cloud now reconnects automatically (with backoff) when it drops or goes quiet, instead of only after a command times out. Commands sent while reconnecting wait for the connection.
  - Fix: the Anova password is no longer written to Homebridge's accessory cache; existing caches are cleaned up on startup.
  - Fix: switch states in the Home app stay in sync. Power On reflects any active cook, and recipe switches update when a cook starts or stops from the app or the oven.
  - Switches for recipes removed from the config are removed from HomeKit.
  - Anova rejecting a command is no longer retried, and HomeKit shows the failure.
  - Housekeeping: removed unused dependencies, declared Node 18–24 and Homebridge 2 support, updated CI.
- Release 1.1.4: Adds a retry/reconnect loop to the websocket connection to the Anova cloud service
- Release 1.1.2: Improves latency of power on/off switch updating
- Release 1.1.1: Pushes status updates to HomeKit API as oven status changes, fixes null dereference on wet bulb temperature status
- Release 1.1.0: Support for Anova Oven Protocol Version 2
- Release 1.0.0: Initial release (supports Anova Oven Protocol Version 1 only)

## Local dev 
`npm run build && npm link && DEBUG=* homebridge -D -C -U .` (uses `config.json` in cwd)

For testing against a mock server, the platform config also accepts `websocketUrl` and `authUrl` to override the Anova endpoints.

## Protocol notes
Inspiration from [mcolyer's oven API V1 reverse engineering results](https://mcolyer.github.io/anova-oven-api/).

### Procedure:
We can man-in-the-middle the HTTPS traffic from the Anova Oven app to find out how the app communicates with the cloud service.

Service domains:
* `wss://app.oven.anovaculinary.io/` - Oven Control API (V1)
* `wss://devices.anovaculinary.io/` - Oven Control API (V2)
* `https://uh9n6t5uyo-3.algolianet.com/` - Community Recipes
* `https://firestore.googleapis.com/` - Oven activity history, saved recipes

Running a man-in-the-middle against the firebase APIs is outside of the scope of my abilities, but here is how to do it for the Anova service:
#### Deploy proxy
1. Set up mitmproxy or Proxyman
2. Start an Android emulator (any device, tested on API34)
3. In emulator, set proxy: Settings -> Wifi -> Select network/edit -> Advanced -> Proxy
4. In emulator, install proxy's SSL root CA (navigate to the install URL in browser, then Settings -> Trusted credentials -> Install a certificate -> CA Certificate -> Select the downloaded CA)

#### Repackage app to trust user CAs
Android apps can specify whether or not to trust user-installed root certificate CA's. To snoop the SSL traffic, we need to edit the app to allow this.

1. Download the most recent Anova Oven App APK (e.g. [from apkpure](https://m.apkpure.com/anova-oven/com.anovaculinary.anovaoven))
2. Use [apktool](https://apktool.org) to unwrap the apk
3. Edit the file `res/xml/network_security_config.xml`:

Before: 
```
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.0.2.2</domain>
        <domain includeSubdomains="true">192.168.4.1</domain>
        <domain includeSubdomains="true">localhost</domain>
    </domain-config>
</network-security-config>
```
After:

```
    <?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">10.0.2.2</domain>
        <domain includeSubdomains="true">192.168.4.1</domain>
        <domain includeSubdomains="true">localhost</domain>
    </domain-config>
     <base-config>
            <trust-anchors>
                <!-- Trust preinstalled CAs -->
                <certificates src="system" />
                <!-- Additionally trust user added CAs -->
                <certificates src="user" />
           </trust-anchors>
      </base-config>
</network-security-config>
```
4. Recompile the APK: `apktool b .` (outputs to `APKName/dist/`)
5. Sign the APK.
    1. If you do not already have a keystore setup for this: `keytool -genkey -v -keystore key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias apkfun` (the cannonical default keystore password to use is `changeit`)
    2. Sign it: `jarsigner -keystore key.jks APKName/dist/APKName.apk apkfun`
    3. Align the native libraries (you'll get some error if not): `zipalign -v 4 APKName/dist/APKName.apk`
6. Install the APK on your emulator (drag and drop the APK to the emulator)


©2023 Jonathan Bell, released under the Apache License 2.0