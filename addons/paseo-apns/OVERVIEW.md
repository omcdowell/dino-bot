APNs push sends iOS push notifications straight to Apple for a self-built Paseo app, with no Expo or third-party relay in between.

The app registers its raw APNs device token with this plugin over plugin RPC (`register` / `revoke`). Programs on the daemon machine ask for a push through a local endpoint on 127.0.0.1 that needs its own bearer token; the plugin signs an ES256 provider token with your APNs auth key and posts to Apple over HTTP/2.

Setup needs an APNs token-auth key (.p8) from your Apple developer team, its key id, the team id, and the app's bundle id (the APNs topic). The key stays on disk where you put it; the plugin reads it by path only when it signs a token.

Limits: one push per 10 minutes, across all senders by default or per sender (`rateLimit.perSender`; on this machine, per bot); refused pushes are not queued. Every sent or refused push is logged locally. Development builds must register as `development` so pushes go to Apple's sandbox host. The plugin sends no badge.
