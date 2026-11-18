# Two people on one Mac

Advanced: only for a second person installing DinoBot on a Mac where someone else already uses
it (or already uses Tailscale). Everyone else: the [Quick start](../README.md#quick-start) is all
you need.

Words used here: your **tailnet** is your own private Tailscale network (your devices, signed in
to your Tailscale account). The Mac's **owner** is the person whose Tailscale app runs on it.

Each person needs their own macOS account. The Mac's Tailscale app belongs to whoever signed it
in; setup stops if it belongs to another macOS user rather than put your bots on their tailnet:

```
DinoBot setup stopped: the Tailscale on this Mac is signed in by another macOS user (...)
```

There are two ways on. Both are set with environment variables, which setup saves in
`~/.config/dinobot/install.env` (mode 600) once they work: later `dinobot` commands, updates and a
reinstall after `dinobot uninstall` use them without you exporting anything again (only
`dinobot uninstall --purge` deletes the file). Setup stops before downloading anything twice:
after the stop, set the variables and run the command it prints,
`~/.dinobot/bin/dinobot setup`.

Before either: close your home folder to other users (`chmod 700 ~`; macOS makes it readable to
every standard user). DinoBot runs only while your account is logged in (fast user switching
keeps it running).

## A. The owner shares the Mac with your Tailscale account (simplest)

No second Tailscale on the Mac. Your phone uses your own Tailscale account; the owner shares the
Mac with it, so your phone reaches the Mac at the Mac's own Tailscale address, and DinoBot (yours)
listens there on a port of its own.

1. **The owner**, once: in the Tailscale admin console, Machines › the Mac › **Share**, to your
   Tailscale account. In the tailnet policy, allow `autogroup:shared` only that Mac's address and
   one port for you (for example `tcp:6747`). The owner's own DinoBot keeps its port (6767).
2. **You**, on your phone: accept the share in the Tailscale app. The Mac shows as "shared in", with
   its address (`100.x.y.z`).
3. **You**, in your macOS account, with that address and port:

   ```sh
   export DINOBOT_TAILNET_ADDRESS=100.x.y.z DINOBOT_PORT=6747
   curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
   ```

   (Or, after the safety stop: the same `export`, then `~/.dinobot/bin/dinobot setup`.)

- `DINOBOT_TAILNET_ADDRESS`: the address DinoBot listens on and puts in the pairing code, instead
  of asking a Tailscale CLI (yours would see the owner's Tailscale). A `,<name>` after it
  (`100.x.y.z,owners-mac.tailnet.ts.net`) is accepted but not put in the code: the code carries the address only.
  It must be an address of this Mac: if the Mac's Tailscale is off, setup says so.
- `DINOBOT_PORT`: the port the owner allowed. Pairing hangs on any other port, so it is saved too.
- Do not open the Tailscale app in your macOS account: it shows and controls the owner's Tailscale.
- The share limits what your **phone** can reach. Your macOS account runs on the owner's Tailscale
  node, so programs you start could reach the owner's tailnet; the owner may want per-user
  firewall (pf) rules for your account.

## B. Your own userspace tailscaled

Run your own userspace `tailscaled` in your home folder (`--tun=userspace-networking
--socket=<path>`; its **socket** is the file the `tailscale` command uses to talk to it), sign it
in to your tailnet, and point setup at it:

```sh
export DINOBOT_TAILSCALE_BIN=<your tailscale CLI> DINOBOT_TAILSCALE_SOCKET=<your tailscaled socket> DINOBOT_PORT=6747
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

- `DINOBOT_TAILSCALE_BIN`: the Tailscale CLI to use. `DINOBOT_TAILSCALE_SOCKET`: its daemon's
  socket (passed as `--socket`).
- `DINOBOT_PORT`: a port the other person's DinoBot does not use.
- A userspace tailscaled has no network interface, so DinoBot listens on `127.0.0.1:<port>` and
  your tailscaled hands it your phone's connections. Because they arrive from `127.0.0.1`, setup
  turns off DinoBot's "same computer" exemption (`PASEO_TRUST_LOOPBACK=false` in
  `~/.dinobot/daemon.env`): a connection from `127.0.0.1` is treated like one from the network. The
  app must use its end-to-end encrypted connection (an outdated app is refused with "update the
  app"), and the only clients let in without it are your own DinoBot tools (`paseo`, your bots),
  which prove themselves with the daemon's local credential, a file only your account can read.

## Updating and removing

`dinobot update` keeps everything above. `dinobot uninstall` keeps `~/.config/dinobot/install.env`,
so installing again needs no exports. `dinobot uninstall --purge` deletes it with everything else.
