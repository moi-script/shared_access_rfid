# Raspberry Pi Kiosk + Cloudflare Tunnel — Deployment Workflow

Operational workflow for deploying the NCST RFID training system onto a Raspberry Pi
acting as a dedicated appliance: a 7" DSI touchscreen as the operator/controller UI, a
large HDMI monitor as the spectator/progress display, and a Cloudflare Tunnel for
remote access only.

This is a **workflow document**, not an implementation plan. It describes the order of
operations, the decision points, and the verification checkpoint at each stage. Commands
are illustrative — confirm each against your actual hardware and image before running.

**Status:** research / pre-implementation. Nothing here has been executed against real
hardware yet.

---

## 0. Target architecture

```
                         ┌──────────────────────────────────────────┐
                         │  Raspberry Pi 5 (the appliance)          │
                         │                                          │
   RFID reader ──USB/──► │  reader bridge ──► serverside :3000      │
                 UART    │                      │                   │
                         │                      ├──► MongoDB        │
                         │                      │                   │
                         │                    userpage :5173        │
                         │                      ▲        ▲          │
                         │        ┌─────────────┘        └────────┐ │
                         │  Chromium #1 (DSI)          Chromium #2│ │
                         │  localhost:5173/control     (HDMI)     │ │
                         │                             /display   │ │
                         └───────────┬──────────────────────────────┘
                                     │ cloudflared (outbound only)
                                     ▼
                          Cloudflare edge ──► rfid.example.com
                                     ▲
                                     │  (remote viewers / adviser / admin)
                                  laptop
```

**Non-negotiable rule:** the two kiosk browsers load `http://localhost:5173`, never the
public hostname. The tunnel exists for *remote* viewers only. If the venue's internet
dies mid-session, the training must keep running.

### Port assignments

| Service | Port | Notes |
| --- | --- | --- |
| `serverside` (Express) | `3000` | matches `PORT` in `serverside/.env.example` |
| `userpage` (Next.js) | `5173` | matches the `dev` script; see decision D-2 below |
| MongoDB | `27017` | local, or Atlas — see decision D-1 |
| `cloudflared` | — | outbound only, no listening port |

> **D-2 conflict to resolve before Phase 4:** `userpage`'s `start` script is bare
> `next start`, which defaults to port **3000** and will collide with the backend.
> Either change it to `next start -p 5173` or move the backend. Decide once, write it
> down, and keep dev and Pi consistent.

---

## Decision log — settle these before touching hardware

Record the choice and the date. These change the work downstream.

| ID | Decision | Options | Default recommendation |
| --- | --- | --- | --- |
| D-1 | Database location | MongoDB Atlas (cloud) vs. local `mongod` on the Pi | **Local.** Atlas makes a training session fail when the internet drops — that defeats the whole offline-first design. Sync/backup to Atlas separately if needed. |
| D-2 | Frontend port in production | `5173` vs. `3000` | **5173**, backend keeps 3000. Fix the `start` script. |
| D-3 | OS image | Pi OS **Desktop** vs. Pi OS **Lite** | **Lite + labwc/cage.** Desktop is easier to debug but a user can escape to the desktop. |
| D-4 | Compositor | `cage` (one app, max lockdown) vs. `labwc` (two windows, more control) | **labwc** — you need two windows on two outputs; `cage` only hosts one app per instance. |
| D-5 | Spectator screen source | Second Chromium on the Pi vs. separate device on the LAN | **Second Chromium on the Pi** if the monitor is next to the Pi; **separate device** if placement is awkward or dual-output placement proves too flaky (see Phase 5 fallback). |
| D-6 | Remote auth | Cloudflare Access (Zero Trust) vs. app-level JWT only | **Both.** Access as the outer gate, existing JWT auth unchanged behind it. |
| D-7 | Storage | SD card vs. USB SSD | **USB SSD** if the system writes scan events continuously. SD cards die from write churn. |

---

## Phase 1 — Bench prep (no Pi yet)

Do this on your development machine. Goal: prove the app can run in the shape the Pi
will run it in.

1. **Split the UI into two routes.**
   - `/control` — operator UI, designed for **800×480** (or 720×1280 on the Touch
     Display 2). Big touch targets, no text entry if avoidable — RFID tap + buttons.
   - `/display` — spectator view, designed for **1920×1080**, readable from across a
     room. No interactive controls.
   - These are genuinely different designs. Do not build one responsive page and hope.

2. **Decide the sync mechanism** between the two views. WebSocket or SSE from
   `serverside`, both views subscribe. Verify it works with two browser windows open
   side by side on your dev machine.

3. **Verify the production build runs**, not just `dev`:
   ```bash
   cd serverside && npm run build && npm start
   cd userpage   && npm run build && npm start   # after fixing D-2
   ```

4. **Confirm `ALLOWED_ORIGINS`** in `serverside/.env` will contain the origins the Pi
   actually uses (`http://localhost:5173`, and the public hostname if remote viewers
   need API access).

5. **Arm-architecture check** — anything with native bindings (`bcrypt` is the one in
   this project) must compile on arm64. Plan to `npm ci` on the Pi itself rather than
   copying `node_modules` from Windows.

**Checkpoint 1:** both routes render correctly at their target resolutions in two
separate browser windows, live-updating from one backend, running from production
builds.

---

## Phase 2 — Base OS

1. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In Imager's
   advanced settings, pre-configure: hostname, SSH + your public key, Wi-Fi, locale.
2. First boot, then:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo raspi-config       # Boot → Console Autologin (Lite has no desktop)
   ```
3. Confirm you can SSH in. **Keep SSH working forever** — it is your only way in once
   the kiosk is locked down.
4. Identify the session type you'll be building against:
   ```bash
   echo $XDG_SESSION_TYPE     # expect: wayland (once a compositor is running)
   ```

**Checkpoint 2:** SSH access confirmed, system updated, autologin to console enabled.

> ⚠️ **The single biggest time sink in this whole project:** most kiosk tutorials
> predate Wayland and tell you to edit `~/.config/lxsession/LXDE-pi/autostart` or
> `/etc/xdg/autostart`. On a Wayland session those files are **silently ignored** —
> nothing errors, nothing starts. Verify `$XDG_SESSION_TYPE` before following any guide.

---

## Phase 3 — Display hardware

Do the physical wiring and display layout *before* the app, so you know your output
names and resolutions.

1. Power off. Connect the 7" DSI panel to the DSI port; connect the HDMI monitor to
   **HDMI0** (the port nearest the USB-C power connector on a Pi 5).
2. Boot, then enumerate outputs:
   ```bash
   wlr-randr                # Wayland
   # or: sudo tvservice -l / xrandr on X11
   ```
   Record the exact output names — typically `DSI-1` and `HDMI-A-1`. **Everything in
   Phase 5 depends on these strings.**
3. Define the virtual desktop layout. Example, DSI on the left:
   ```
   DSI-1     at 0,0        800×480
   HDMI-A-1  at 800,0      1920×1080
   ```
   Write these coordinates down — you will need them for window positioning.
4. **Map touch input to the DSI output.** Without this, taps on the 7" panel land on
   the HDMI screen. Wayland: output association in the compositor config. X11:
   `xinput map-to-output` / coordinate transformation matrix.
5. Disable screen blanking and idle timeouts (compositor config, e.g. `idle-timeout = 0`).

**Checkpoint 3:** both screens light up, `wlr-randr` reports the expected layout, and a
tap on the touchscreen moves the cursor **on the touchscreen**, not on the monitor.

---

## Phase 4 — Application services

Get the app running headlessly and verify over SSH before any browser is involved.

1. Install Node (match your dev major version), and MongoDB if D-1 = local.
2. Deploy the code (`git clone`, or `rsync` from your machine), then on the Pi:
   ```bash
   cd serverside && npm ci && npm run build
   cd ../userpage && npm ci && npm run build
   ```
3. Populate `serverside/.env` on the Pi. **Real secrets, not the `.env.example`
   placeholders** — new `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`,
   a real `ADMIN_PASSWORD`. Set `NODE_ENV=production` and tighten
   `LOGIN_RATE_LIMIT_MAX` (the example file's `50` is explicitly a dev value).
4. Seed the database: `npm run seed`.
5. Create **systemd units** for each service — `rfid-backend.service`,
   `rfid-frontend.service` — with `Restart=always` and `After=network-online.target`.
   Enable both.
6. Verify from your laptop over SSH port-forwarding, before any kiosk exists:
   ```bash
   ssh -L 5173:localhost:5173 -L 3000:localhost:3000 pi@raspberrypi.local
   # then browse http://localhost:5173/control on your laptop
   ```

**Checkpoint 4:** `systemctl status` green for both services; reboot the Pi and confirm
both come back automatically; `/control` and `/display` both reachable via SSH tunnel.

---

## Phase 5 — Kiosk layer

This is the phase most likely to fight you. Build it incrementally.

### 5a. One screen first

1. Install the compositor and browser:
   ```bash
   sudo apt install -y labwc chromium-browser
   ```
2. Launch labwc manually from the console and confirm it starts.
3. Launch one Chromium fullscreen by hand:
   ```
   chromium-browser --kiosk http://localhost:5173/control \
     --user-data-dir=/home/pi/.kiosk/control \
     --noerrdialogs --disable-infobars --no-first-run \
     --disable-session-crashed-bubble --check-for-update-interval=31536000
   ```
   Confirm it fills a screen with no chrome, no address bar, no popups.

**Checkpoint 5a:** one fullscreen kiosk window, manually launched.

### 5b. Two screens

Two Chromium windows on two outputs. Attempt in this order, stopping at the first that
works reliably:

1. **Compositor window rules** — labwc `rc.xml` rules (or wayfire `start_on_output`)
   binding each window to an output by app-id or title. Cleanest if it works. Known to
   be unreliable: multiple reports of both windows stacking on the same output despite
   correct rules.
2. **Explicit coordinates** — using the layout from Phase 3:
   ```
   # control on DSI at 0,0
   --window-position=0,0     --window-size=800,480
   # display on HDMI at 800,0
   --window-position=800,0   --window-size=1920,1080
   ```
   Cruder but deterministic. Usually the one that ends up shipping.
3. **One compositor per output** — two `cage` instances, each bound to one output via
   its own `WAYLAND_DISPLAY`. Most isolated: either screen can crash and restart without
   affecting the other. Most setup work.

> **Mandatory:** each Chromium instance needs its **own `--user-data-dir`**. With a
> shared profile, the second launch just hands the URL to the first process and you get
> one window, not two. This is the most common two-screen failure and it looks like the
> second command "did nothing."

**Fallback (D-5):** if placement stays flaky after a reasonable effort, drop the second
Chromium and serve `/display` to a separate device on the LAN — another Pi, a laptop, a
smart-TV browser. This removes all dual-output pain and arguably makes the architecture
*better*: any screen on the network can join as a display.

**Checkpoint 5b:** correct URL on the correct physical screen, both live-updating from
the same session, touch working on the DSI panel only.

### 5c. Autostart

1. Move the launch commands into `~/.config/labwc/autostart`, or better, into **systemd
   user services** so you get `Restart=always` per window.
2. Switch `raspi-config` boot target to autologin into the graphical session.
3. **Reboot and watch.** Full cold boot to both kiosks up, hands off keyboard.

**Checkpoint 5c:** power on → both screens show the right UI, with no human input.

---

## Phase 6 — Lockdown

Only after Phase 5 is solid, and keep an SSH escape hatch at every step.

- [ ] Hide the mouse cursor (compositor setting; `unclutter` on X11).
- [ ] Strip compositor keybinds in labwc `rc.xml` — no Alt+Tab, no window close, no
      terminal spawn.
- [ ] Disable VT switching (Ctrl+Alt+F1–F6) at the seat level, so a keyboard can't drop
      to a console.
- [ ] Scrub the Chromium profile's `exit_type` key on boot, or the **"Restore pages?"**
      bubble will sit on screen forever after an unclean shutdown.
- [ ] Screen Wake Lock API from the web app as a second line of defence against blanking.
- [ ] `Restart=always` on every unit — backend, frontend, both browsers, `cloudflared`.
- [ ] Consider read-only root via `overlayfs` with a writable data partition (D-7).
- [ ] Decide and document your **maintenance escape hatch**: SSH is primary; optionally a
      hidden long-press gesture or a GPIO button that stops the kiosk units.

**Checkpoint 6:** with a USB keyboard plugged in, you cannot reach a desktop, a terminal,
a different URL, or a browser menu. Pull the power cord mid-session; on reboot the system
returns to a clean kiosk with no dialogs.

---

## Phase 7 — Cloudflare Tunnel

Remote access only. The kiosk keeps using localhost.

1. Prerequisite: a domain with DNS managed by Cloudflare, and a Cloudflare account.
2. Install and authenticate:
   ```bash
   # install cloudflared for arm64, then:
   cloudflared tunnel login
   cloudflared tunnel create ncst-rfid       # writes a credentials JSON
   ```
3. Configure ingress in `~/.cloudflared/config.yml` — map the public hostname to the
   **local** service:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/pi/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: rfid.example.com
       service: http://localhost:5173
     - service: http_status:404
   ```
4. Route DNS: `cloudflared tunnel route dns ncst-rfid rfid.example.com`
5. Install as a service so it survives reboots and network blips:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```
6. **Verify WebSocket/SSE passes through the tunnel** — free-plan Cloudflare proxies
   WebSockets, but confirm your live-progress push actually works from a remote browser,
   not just plain page loads.
7. Add the public hostname to `ALLOWED_ORIGINS` in `serverside/.env` if remote viewers
   call the API directly. Restart the backend.
8. **D-6 — Cloudflare Access:** put a Zero Trust policy (email OTP or Google SSO) in
   front of `rfid.example.com`. Your existing JWT auth stays untouched behind it.

> ⚠️ If you ever route the kiosk browser through the public hostname, Access will block
> it — it has no human to complete the login. That would need a service token or a bypass
> policy. Yet another reason the kiosk stays on `localhost`.

**Checkpoint 7:**
- From mobile data (not the venue Wi-Fi), `https://rfid.example.com` loads and shows
  live session progress.
- **Then unplug the Pi's internet.** Both kiosk screens must keep working normally.
  If they don't, something is still routing through the tunnel — fix it before shipping.

---

## Phase 8 — Field readiness

| Item | Why |
| --- | --- |
| Cold-boot test ×3 | Autostart races (network-before-service, display-before-compositor) are intermittent. One success proves nothing. |
| Power-loss test | Yank the cord mid-session. Verify recovery with no dialogs and no data corruption. |
| Full-session dry run | Complete training session end to end on the real hardware, with the real RFID reader. |
| Network-loss test | Unplug WAN mid-session; confirm nothing degrades locally. |
| Backup / restore | Image the storage once the build is good. Know how to restore it the night before a defense. |
| Log rotation | Continuous scan logging fills the disk. Cap journald and app logs. |
| Time sync | Attendance uses `LATE_CUTOFF_TIME`. A Pi with no RTC and no internet boots with a wrong clock. Consider an RTC module. |
| Physical | Cable strain relief, mounting, thermals under sustained load. |

---

## Failure playbook

| Symptom | Most likely cause |
| --- | --- |
| Kiosk doesn't autostart after an OS upgrade | Wayland ignoring X11-era autostart files. Check `$XDG_SESSION_TYPE`, move config to `labwc/autostart` or a systemd user unit. |
| Second Chromium "does nothing" | Shared `--user-data-dir`. Give each instance its own. |
| Both windows on the same screen | `start_on_output` / window rules not honored. Fall back to explicit `--window-position` coordinates. |
| Taps land on the wrong screen | Touch input not mapped to the DSI output. |
| Screen goes black mid-session | Compositor idle timeout still set; add Wake Lock in the app. |
| "Restore pages?" bar stuck on screen | Unclean shutdown; scrub `exit_type` on boot and add `--disable-session-crashed-bubble`. |
| App works locally, dead remotely | `cloudflared` not enabled as a service, DNS route missing, or Access policy blocking. |
| App dies when internet drops | Something local is going through the tunnel, or D-1 was answered "Atlas". |
| Random corruption after weeks | SD card write wear (D-7). |
| `npm ci` fails on the Pi | Native modules (`bcrypt`) need arm64 build tools; never copy `node_modules` from Windows. |

---

## Known-risky areas

Ranked by expected pain:

1. **Dual-output window placement** (Phase 5b) — the flakiest part of the stack. Budget
   real time, and keep the D-5 fallback genuinely available.
2. **Wayland vs. X11 confusion** — costs an evening if you follow a stale guide.
3. **Touch-to-output mapping** with mixed DSI + HDMI.
4. **Autostart ordering races** — services starting before the network or the display is
   ready.

---

## References

- [How to use a Raspberry Pi in kiosk mode — Raspberry Pi](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)
- [A Chromium Kiosk for Wayland/labwc — Raspberry Pi Forums](https://forums.raspberrypi.com/viewtopic.php?t=390764)
- [Kiosk mode on RPi 5 with Bookworm Lite (working in 2025)](https://forums.raspberrypi.com/viewtopic.php?t=389880)
- [Fixing Raspberry Pi kiosk autostart after Bookworm update](https://industrialmonitordirect.com/blogs/knowledgebase/fixing-raspberry-pi-kiosk-autostart-after-bookworm-update)
- [Start Chromium on second screen with Wayland/wayfire](https://forums.raspberrypi.com/viewtopic.php?t=366093)
- [Raspberry-Pi-Kiosk-Display-System (GitHub)](https://github.com/TOLDOTECHNIK/Raspberry-Pi-Kiosk-Display-System)
- [Pi 5 with 2 DSI-touchscreens and 2 HDMI-touchscreens](https://forums.raspberrypi.com/viewtopic.php?t=367650)
- [Screen Configuration on Raspberry Pi 5](https://thinkrobotics.com/blogs/learn/how-to-use-screen-configuration-on-raspberry-pi-5-a-step-by-step-guide)
- [Installing Cloudflare Tunnel (cloudflared) on Raspberry Pi 5](https://www.mykolaaleksandrov.dev/posts/2025/07/cloudflare-tunnel-raspberrypi5/)
- [Cloudflare Tunnel on Raspberry Pi: Zero-Trust Access Without Ports](https://www.brianhaman.com/grc-blog/cloudflare-tunnel-raspberry-pi-zero-trust)
- [Cloudflare Tunnel + Raspberry Pi + Docker — peppe8o](https://peppe8o.com/cloudflare-tunnel-raspberry-pi/)
