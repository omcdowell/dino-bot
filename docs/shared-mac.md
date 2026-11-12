# Two people on one Mac

Advanced: only for a second person installing DinoBot on a Mac where someone else already uses
it (or already uses Tailscale). Everyone else: the [Quick start](../README.md#quick-start) is all
you need.

Words used here: your **tailnet** is your own private Tailscale network (your devices, signed in
to your Tailscale account). A **userspace** `tailscaled` is a Tailscale you start yourself in your
own account, without the system app; its **socket** is the file the `tailscale` command uses to
talk to it.

Each person needs their own macOS account and their own tailnet. The Mac's Tailscale app belongs
to whoever signed it in; setup stops if it belongs to another macOS user rather than put your bots
on their tailnet. Run your own userspace `tailscaled` in your home folder instead
(`--tun=userspace-networking --socket=<path>`), sign it in to your tailnet, and point setup at it:

```sh
export DINOBOT_TAILSCALE_BIN=<your tailscale CLI> DINOBOT_TAILSCALE_SOCKET=<your tailscaled socket> DINOBOT_PORT=6747
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

- `DINOBOT_TAILSCALE_BIN`: the Tailscale CLI to use. `DINOBOT_TAILSCALE_SOCKET`: its daemon's
  socket (passed as `--socket`). Later `dinobot` commands remember both.
- `DINOBOT_PORT`: a port the other person's DinoBot does not use.
- A userspace tailscaled has no network interface, so DinoBot listens on `127.0.0.1:<port>` and
  your tailscaled hands it your phone's connections. Because they arrive from `127.0.0.1`, setup
  turns off DinoBot's "same computer" exemption (`PASEO_TRUST_LOOPBACK=false` in
  `~/.dinobot/daemon.env`): a connection from `127.0.0.1` is treated like one from the network. The
  app must use its end-to-end encrypted connection (an outdated app is refused with "update the
  app"), and the only clients let in without it are your own DinoBot tools (`paseo`, your bots),
  which prove themselves with the daemon's local credential, a file only your account can read.
- Close your home folder to other users first (`chmod 700 ~`; macOS makes it readable to every
  standard user). DinoBot runs only while your account is logged in (fast user switching keeps it
  running).
