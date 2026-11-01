# DinoBot on Windows

> **Untested:** not yet tried on a real Windows PC; tested only in Linux containers with faked WSL
> markers.

On Windows, DinoBot runs inside **WSL** (Windows Subsystem for Linux), in a small Ubuntu that
Windows provides. Your iPhone reaches it over Tailscale, as on a Mac or Linux PC. You need
Windows 10 (version 2004 or newer) or Windows 11, 64-bit. The set-up takes about 20 minutes.

The [README](../README.md) explains the app and Tailscale. This page only covers what is
different on Windows.

## Steps

**1. Install Ubuntu.** Right-click the Start button, choose **Terminal (Admin)** (on Windows 10:
**Windows PowerShell (Admin)**), and run:

```
wsl --install -d Ubuntu-24.04
```

Restart Windows if it asks. Then open **Ubuntu 24.04** from the Start menu and choose a user name
and password. From here on, every line goes into this **Ubuntu** window, not PowerShell.

**2. Add the tools DinoBot needs** (it asks for the password you just chose):

```
sudo apt update && sudo apt install -y curl procps bzip2 git
```

**3. Install Tailscale inside Ubuntu.** The first line installs it; the second prints a login
link: open it in your browser and log in.

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator=$USER
```

Ubuntu now appears as its own computer in your Tailscale list. On the iPhone, install Tailscale
and log in with the same account.

**4. Install DinoBot.** In the Ubuntu window, run the install line from the
[README](../README.md#quick-start):

```
curl -fsSL https://omcdowell.github.io/dino-bot/install | sh
```

Answer its questions. At the end you see a QR code.

**5. Keep it running.** Windows stops Ubuntu shortly after you close its last window, and your
bots stop with it. This line makes Windows start Ubuntu when you sign in and keeps it running:

```
~/.dinobot/bin/dinobot wsl-autostart
```

If setup said **"run once: sudo loginctl enable-linger …"**, run that line too. Then sign out of
Windows and back in.

**6. Connect the iPhone.** Scan the QR code with the DinoBot app. To show
the code again: `~/.dinobot/bin/dinobot pair`.

To check everything: `~/.dinobot/bin/dinobot doctor`.

## What `wsl-autostart` changes

- A small file in your Windows **Startup** folder, `DinoBot (WSL Ubuntu-24.04).cmd`. When you sign
  in, it starts Ubuntu and DinoBot (a window may flash for a moment).
- In `C:\Users\<you>\.wslconfig`, `[general] instanceIdleTimeout=-1`, so Ubuntu keeps running
  with no window open. Your other settings are kept, and the old file is saved as
  `.wslconfig.dinobot-backup`. This applies to every WSL distribution on this PC.

`~/.dinobot/bin/dinobot wsl-autostart --off` undoes both. Keep the PC switched on and signed in:
when it sleeps, the bots cannot answer.

## Using Tailscale for Windows instead (Windows 11 only)

If Tailscale is already installed on Windows and you would rather not run it inside Ubuntu as
well, WSL's **mirrored** networking lets Ubuntu use the Windows one. You need Windows 11 22H2 or
newer.

1. Add this to `C:\Users\<you>\.wslconfig` (create the file if it isn't there):
   ```
   [wsl2]
   networkingMode=mirrored
   ```
2. In PowerShell run `wsl --shutdown`, then open Ubuntu again.
3. Install DinoBot (step 4). It finds the Windows Tailscale by itself.
4. Windows' firewall for WSL blocks connections from your phone by default. Setup prints one
   PowerShell line for this, starting `New-NetFirewallHyperVRule`. Run it once in
   **Terminal (Admin)**. It lets in DinoBot's port, and only from your Tailscale devices.

Don't run Tailscale inside Ubuntu as well in mirrored mode; the two get in each other's way.

The third option, `netsh interface portproxy`, is not supported. It needs an administrator,
Ubuntu's address changes at every restart, and DinoBot would have to listen outside Tailscale.

## If something goes wrong

- **"this Ubuntu runs on WSL 1"**: in PowerShell run `wsl --set-version Ubuntu-24.04 2`.
- **"is on a Windows drive"**: install from Ubuntu's own home folder (`cd ~`), not from
  `/mnt/c/…`. Windows drives are slow for the bots' many small files and can't keep DinoBot's
  password private.
- **"Tailscale is on in Windows, but Ubuntu runs behind WSL's own network"**: do step 3 (or use
  mirrored networking, above).
- **No systemd**: Ubuntu 24.04 has it switched on. If doctor says it is off, run
  `printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf`, then `wsl --shutdown` in
  PowerShell, open Ubuntu and run `~/.dinobot/bin/dinobot setup`.
- **Dictation** runs on the processor. A graphics card is not used and not needed.

## Removing DinoBot

```
~/.dinobot/bin/dinobot wsl-autostart --off
~/.dinobot/bin/dinobot uninstall --purge
```

What `uninstall` leaves on purpose is listed in [Linux: Uninstall](linux.md#uninstall). To remove
Ubuntu completely, run
`wsl --unregister Ubuntu-24.04` in PowerShell. This deletes everything inside it.

## Technical details

- **Detection** (`lib/wsl.mjs`, `install.sh`): `/proc/version` (`microsoft-standard`/`WSL2`; WSL 1 says
  `Microsoft`) or `WSL_DISTRO_NAME`. Git Bash/MSYS (`uname` MINGW…) is pointed to `wsl --install`.
  WSL 1 stops (no Tailscale there). An install root on a Windows drive (`/mnt/<letter>/…`) stops (no
  Unix modes: `daemon.env` could not be 600; slow); bots there is a warning.
- **Services:** systemd user units as on Linux, but only with a working user bus
  (`/run/user/<uid>/bus`), else detached processes. `systemctl --user` gets
  `XDG_RUNTIME_DIR`/the bus address filled in when started from Windows (no login session).
- **Keep running:** WSL stops a distro about 15 s after its last client (`[general]
  instanceIdleTimeout`, default 15000), systemd or not; hence `dinobot wsl-autostart [--off]`.
- **Networking:** WSL 2 is NAT'd. Recommended: Tailscale inside Ubuntu. Tailscale on Windows
  (`tailscale.exe` through interop) is used only when its address is on a Linux interface, i.e.
  `networkingMode=mirrored`. Windows Tailscale with NAT stops setup with the steps. Never 0.0.0.0.
- **Dictation:** the bundled sherpa-onnx is CPU-only, so a GPU is never needed.
- Tests: `node --test test/wsl.test.mjs` (faked WSL markers; no Windows needed).
