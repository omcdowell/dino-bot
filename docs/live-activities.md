# Live Activities and push notifications

A DinoBot install works without them: you chat with your bots in the app, and the app shows
what they are doing while it is open. Push notifications (a bot messages you while the app is
closed) and the Live Activity on the lock screen (which bots are working, and their workers)
need one more thing: **an iPhone app you build yourself, with your own Apple developer account,
and your own push key.**

Why: Apple only delivers a push that is signed with a key from the same developer team that
signed the app. Nobody else's key can reach your phone, and your key cannot reach anyone else's
app. So each person who wants pushes builds the app under their own team and gives DinoBot their
own key.

The push add-on (`apns`) is in every DinoBot download, but it is **off**. Setup does not ask
about it, and it stays off until you turn it on with `dinobot push enable`.

## What you need

- A paid [Apple Developer Program](https://developer.apple.com/programs/) membership (a free
  account cannot use push notifications).
- A Mac with Xcode, and Node.js (current LTS) to build the app.
- An iPhone on iOS 16.2 or later, connected to the Mac once to install the app.
- DinoBot installed on your computer (the one-line install in the [README](../README.md)).

You will collect four values. Write them down as you go:

| Value | Example | Where it comes from |
|---|---|---|
| Team ID | `<TEAM_ID>` (10 characters) | developer.apple.com › Account › Membership details |
| Bundle ID | `com.yourname.dinobot` | you choose it; it must be unique to you |
| Key ID | `<KEY_ID>` (10 characters) | shown when you create the push key |
| Key file | `/path/to/AuthKey_<KEY_ID>.p8` | downloaded when you create the push key |

## 1. Set up your Apple developer account

In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources):

1. **Identifiers › +  › App IDs › App.** Bundle ID (explicit): `com.yourname.dinobot` (use your
   own). Under Capabilities tick **Push Notifications**.
2. Again for the Lock Screen widget: Bundle ID `com.yourname.dinobot.LiveActivity` (your app's ID
   plus `.LiveActivity`). No extra capabilities.
3. **Devices › +**: add your iPhone (its UDID is in Finder or Xcode when the phone is plugged in).
4. **Profiles › + › iOS App Development**, one for each App ID, both with your iPhone and your
   development certificate. Name them exactly:
   - `Paseo Dev` for `com.yourname.dinobot`
   - `Paseo LiveActivity Dev` for `com.yourname.dinobot.LiveActivity`

   (The app's build looks the profiles up by these names.) Download both and double-click them
   so Xcode has them.
5. **Keys › +**: name it, tick **Apple Push Notifications service (APNs)**, register, then
   **Download** the `.p8` file. Apple lets you download it only once. Note the Key ID. If Apple
   asks for an environment, choose **Sandbox & Production**.

## 2. Build the app with your own IDs

On the Mac:

```sh
git clone --depth 1 https://github.com/omcdowell/dino-bot.git dinobot
cd dinobot/paseo
npm ci
cd packages/app
export PASEO_BUNDLE_ID=com.yourname.dinobot       # your bundle ID
export PASEO_APPLE_TEAM_ID=<TEAM_ID>             # your Team ID
export PASEO_PUSH_TRANSPORT=apns                 # pushes from the add-on on your computer
export PASEO_APNS_ENVIRONMENT=development        # Xcode / development-profile builds
node scripts/apply-flavour.mjs                   # points the widget at your bundle ID's keychain group
npx expo prebuild --platform ios --clean
npm run ios:release -- --device                  # pick your iPhone
```

The three Apple values are build settings, not part of the source: nobody's real IDs are in the
code, and every build is signed by whoever builds it.

| Setting | What | Default |
|---|---|---|
| `PASEO_BUNDLE_ID` | the app's bundle ID (`PASEO_OWN_BUNDLE_ID` is the older name and still works) | a placeholder, `com.example.paseo` (or `com.example.dinobot` with `PASEO_FLAVOUR=public`) |
| `PASEO_WIDGET_BUNDLE_ID` | the Live Activity (lock screen widget) extension's bundle ID; Apple requires it to start with the app's ID and a dot | the app's ID plus `.LiveActivity` |
| `PASEO_APPLE_TEAM_ID` | your developer team | none (Xcode asks) |

The placeholders are fine for the simulator. A distribution build of the DinoBot-named app
(`PASEO_FLAVOUR=public` with `PASEO_APNS_ENVIRONMENT=production`, or an EAS build) stops with an
error until `PASEO_BUNDLE_ID` is set, so nothing is uploaded under an ID nobody owns.

This is the "own" build of the same app: it is called **Paseo** on the home screen, and shows a
few extra developer options and raw model names. It sits next to the DinoBot app from the App
Store or TestFlight; they do not share data.

Pair it with your computer from inside the app: scan the QR from `dinobot pair` with the app's
own scanner, or run `dinobot pair --link` and use **Paste pairing link**. (The iPhone camera
opens the DinoBot app's links, not this build.)

## 3. Turn on the add-on on your computer

Copy the `.p8` key to the computer that runs DinoBot, somewhere only you can read:

```sh
mkdir -p ~/.dinobot/keys && chmod 700 ~/.dinobot/keys
mv /path/to/AuthKey_<KEY_ID>.p8 ~/.dinobot/keys/ && chmod 600 ~/.dinobot/keys/AuthKey_<KEY_ID>.p8
```

Then:

```sh
~/.dinobot/bin/dinobot push enable \
  --key-path ~/.dinobot/keys/AuthKey_<KEY_ID>.p8 \
  --key-id <KEY_ID> --team-id <TEAM_ID> --topic com.yourname.dinobot
```

`--topic` is your app's bundle ID. This writes the add-on's settings to `~/.dinobot/apns`
(readable only by you), registers the add-on with DinoBot and restarts it. The key itself stays
where you put it: DinoBot stores only its path and reads it only to sign a push. Bots run as
your user, so like any file of yours they could read it; keep it out of your bots' folders.

## 4. Check that it works

1. Open the app on your iPhone, connected to your computer, and allow notifications.
2. On the computer:

   ```sh
   ~/.dinobot/bin/dinobot push status   # on, your app, "1 registered" phone, add-on answering
   ~/.dinobot/bin/dinobot push test     # sends one test notification
   ```

   Lock the phone or switch to another app first to see the test notification.
3. Give a bot a task in the app and lock the phone: the Live Activity shows the bot, its workers
   and a timer, and goes away when they are done.

Alerts are limited to one per bot every 10 minutes; the Live Activity is not limited that way.

If something fails, `~/.dinobot/apns/push-log.jsonl` says why (one line per push or
registration; the code or Apple's reason is in it):

| Code or reason | Usually |
|---|---|
| `not_configured` | a value in `~/.dinobot/apns/config.json` is wrong; run `push enable` again |
| `key_error` | the key path is wrong, or the file is not readable by you |
| `BadDeviceToken` | the app's environment does not match: Xcode builds are `development` |
| `wrong_topic`, `DeviceTokenNotForTopic` | `--topic` is not the bundle ID the app was built with |
| `no_device` | the app has not registered yet: open it while connected, allow notifications |

## Turn it off

```sh
~/.dinobot/bin/dinobot push disable
```

The add-on stops; its settings stay in `~/.dinobot/apns`, so `push enable` brings it back.
Revoke the key in your Apple account if you no longer need it.

## Without your own build

`dinobot push enable --local` turns the add-on on without a key. There are no pushes; the
Live Activity is shown and updated by the app itself, so it is live only while the app is open
and greys out a while after you leave it.

## TestFlight and App Store builds

If you distribute your own build through TestFlight, build it with
`PASEO_APNS_ENVIRONMENT=production` and your distribution profiles; the same key works for both
environments (if you made it for both). This guide does not cover that signing setup, and it
has not been tried with this add-on yet.
