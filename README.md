# n8n-nodes-freebox

n8n community node for reading and controlling a Freebox through the Freebox OS API: devices, connection, Wi-Fi, downloads, calls, contacts, parental control and Freebox Players.

It reads almost everything and changes only a few **low-risk** things: wake
or rename a device, pause Wi-Fi for a while, add or pause downloads, mark
calls and voicemail as read, allow or block a parental-control profile for a
while, and control a Freebox Player. It can't reboot the box, change the
firewall, port forwarding, VPN or Wi-Fi passwords, format disks or delete
files. It can also be used as a tool by n8n's AI Agent.

Tested on a Freebox Ultra (v8), Freebox OS API 16.1.

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `n8n-nodes-freebox`. n8n must be able to reach the box: on the
same network as `mafreebox.freebox.fr`, or through the box's remote access.

## Credentials

The Freebox API uses an **app token**, granted once on the box itself.

1. From a computer on the Freebox's network (the box refuses token requests
   from outside), run `node scripts/authorize.cjs` in this package.
2. The Freebox display asks whether to accept the app **n8n**: press the
   **right arrow** to accept. The script saves `FREEBOX_APP_ID` and
   `FREEBOX_APP_TOKEN` to `.env`.
3. In n8n, create a **Freebox API** credential with that **App ID** and
   **App Token**. The **Freebox URL** defaults to `http://mafreebox.freebox.fr`.
   For remote access use `https://<api_domain>:<https_port>` (both are shown
   at `http://mafreebox.freebox.fr/api_version`) and turn on **Ignore SSL
   Issues**: the box's certificate is signed by Free's own authority.

The credential test opens a real session, so it checks the token as well as
the address. If you revoke the app in Freebox OS, create a new token with
step 1.

### Permissions

The box gives a new app only some permissions. Grant the others in Freebox OS
under *Paramètres de la Freebox > Gestion des accès > Applications*, on the
**n8n** app. An operation that lacks one fails with a message naming it.

| Permission (API name; Freebox OS shows it in French) | Needed by | Granted by default |
|---|---|---|
| `downloader` (downloads) | Download (all) | yes |
| `calls` | Call, Voicemail | yes |
| `contacts` | Contact | yes |
| `settings` (changing the box's settings) | Device: Rename, Wake; Wi-Fi: Pause, Resume, Set Schedule | no |
| `parental` (parental control) | Parental Control | no |
| `player` (Freebox Player control) | Player | no |

Reading devices, connection, Wi-Fi, DHCP and system status needs none of these.

## Operations

| Resource | Operation | What it returns |
|---|---|---|
| Device | Get Many | Devices the box has seen on the network (name, type, vendor, MAC, IPs, active, last seen); optionally active ones only |
| Device | Get | One device by its ID (e.g. `ether-aa:bb:cc:dd:ee:ff`) |
| Device | Rename | Set the name the box shows for a device |
| Device | Wake | Send a Wake-on-LAN packet (by MAC address or device ID) |
| Connection | Get Status | State, IPv4/IPv6, current rates, bandwidth, traffic counters |
| Connection | Get Line | Fiber (FTTH) or DSL line details, whichever the box uses |
| Connection | Get Configuration | Remote access, ping, Wake-on-LAN, ad blocking and similar settings |
| Wi-Fi | Get State | Whether Wi-Fi is on, its state, power saving |
| Wi-Fi | Get Access Points | Each radio (band), channel and status |
| Wi-Fi | Get Networks | Each network (SSID) and its status. **The Wi-Fi password is never returned.** |
| Wi-Fi | Pause / Resume | Turn Wi-Fi off for some minutes (optionally keeping one band on, e.g. to pair a 2.4 GHz device); it comes back by itself |
| Wi-Fi | Set Schedule | Turn the Wi-Fi on/off schedule set in Freebox OS on or off |
| DHCP Lease | Get Many | Addresses handed out by the box, optionally with static leases |
| Download | Get Many / Get / Get Statistics | Downloads with status and progress; task counts and rates |
| Download | Add | Download one or more URLs (HTTP, FTP, magnet, .torrent link), optionally to a folder and file name |
| Download | Update | Pause, resume, retry or seed a download, or change its priority |
| Download | Set Speed Mode | Normal, slow, hibernate (all paused) or back to the schedule |
| Call | Get Many | The call log, newest first, filterable by type (missed, accepted, outgoing) and unread |
| Call | Mark as Read / Mark All as Read | Clear the unread flag on one call or all of them |
| Voicemail | Get Many | Voicemail messages (not the audio) |
| Voicemail | Mark as Read | Mark one message as listened to |
| Contact | Get Many / Get | The box's address book; a call's `contact_id` is a contact's ID |
| Parental Control | Get Many | Each profile's current access, devices and next scheduled change |
| Parental Control | Set Access | Allow or block a profile for some minutes (0 = until changed), or go back to its schedule |
| Player | Get Many | Freebox Players on the network |
| Player | Media Control / Set Volume | Play/pause, stop, previous, next; volume and mute |
| System | Get | Model, firmware, uptime, temperatures, fans, disk status |

List operations have **Return All** or **Limit**. Devices, connection
status, downloads, calls and system have an **Output** setting: **Simplified**
(the most useful fields), **Raw** (everything) or **Selected Fields** (the
ID plus the fields you pick).

## Rate limit

The box has no published request limit for this API. It does rate-limit
**authentication errors** (`ratelimited`): a wrong app token repeated many
times locks the app out for a while. The node opens one session per n8n
process and re-opens it only when the box says it expired
(`auth_required`), so normal use makes one login, not one per request.
**Retry On Fail** is safe for network hiccups; n8n retries every error,
including "not found".

## Design notes

- **Programmatic node with its own session handling.** The Freebox answers an
  expired session with HTTP 403 `auth_required`. n8n's built-in session
  credentials (`preAuthentication`) only refresh after a 401, so they would
  keep a dead session forever. The node opens a session from the app token
  (challenge + HMAC-SHA1) and re-opens it once on `auth_required`.
- **API version:** discovered from the box's `/api_version`, not hard-coded.
  The box serves up-to-date API docs at `http://mafreebox.freebox.fr/doc/index.html`
  (dev.freebox.fr still documents API 4.0).
- **Only low-risk writes.** The API can also reboot or shut down the box,
  change the firewall, port forwarding, DHCP, VPN and Wi-Fi settings, format
  disks and delete files. None of that is exposed, so neither a workflow nor
  an AI Agent can lock you out of your network. The Wi-Fi pause and parental
  overrides end by themselves when a duration is set.
- **Download: Add** sends a form-encoded body (the only endpoint that needs
  one) with the folder base64-encoded, as the API expects. The box accepts a
  folder that doesn't exist and the task then fails with an error status.

## Icon

The Freebox wordmark from Wikimedia Commons,
[File:Freebox (logo).svg](https://commons.wikimedia.org/wiki/File:Freebox_(logo).svg)
(public domain), placed unchanged on a square canvas. Freebox is a trademark
of Free (Iliad); this package is not affiliated with Free.

## Development

```
npm install
npm run build      # compile and copy icons/codex into dist/
npm run lint
npm test           # unit tests (fake box: session, retry, empty lists)
npm run test:e2e   # needs a local n8n with this package linked and a Freebox API credential
npm run test:fixtures   # the workflows in test/fixtures, which check themselves (stop n8n start first)
```

`test:e2e` runs the node through n8n's engine and checks the number of real
HTTP calls with Retry On Fail off (1) and on with 3 tries (3).

### Local test setup

1. `node scripts/authorize.cjs` (once; press the arrow on the box).
2. `node scripts/seed-credential.cjs` imports the token from `.env` into the
   local n8n as "Freebox API (test)".
3. Link the package into n8n. On Windows a directory junction leaves other
   linked packages alone:
   `cmd /c mklink /J "%USERPROFILE%\.n8n\custom\node_modules\n8n-nodes-freebox" "<this folder>"`
4. `node test/fixtures/build.cjs` regenerates `test/fixtures/all-operations.json`
   (every operation). Run it with the n8n-node-builder skill's
   `scripts/n8n-run.mjs --count-http mafreebox.freebox.fr`.

## License

MIT
