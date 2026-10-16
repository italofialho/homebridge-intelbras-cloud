# homebridge-intelbras-cloud

Homebridge plugin for Intelbras DVR cameras over **T2U Cloud CONNECT** or a
**direct IP connection**. Each selected DVR channel is published as a separate
Apple Home camera with snapshots, live video and a motion sensor. The plugin also
provides optional HomeKit Secure Video and an interface for existing DVR recordings.

**Prerelease:** validated with an Intelbras MHDX 3108, including eight channels on
Linux ARM64. Other models and firmware are not automatically considered supported.
See [compatibility](docs/COMPATIBILITY.md) and [validation](docs/VALIDATION.md).

## Requirements

- An existing Homebridge installation: 1.8+ or 2.x, with Node.js 22 or 24.
- Homebridge UI for visual configuration, diagnostics and recording history.
- DVR credentials with permission to view the selected channels and recordings.
- Cloud mode: the DVR serial number and a reachable T2U CONNECT endpoint.
- Direct mode: a reachable DVR IP address or hostname and its HTTP/RTSP ports.

FFmpeg is provided by the `ffmpeg-for-homebridge` dependency. If its binary download
is unavailable, install FFmpeg on the Homebridge host/container and make it available
on `PATH`, or set `INTELBRAS_FFMPEG_PATH` to its full path in the Homebridge service
or container environment. FFmpeg must run in the same environment as Homebridge.

No separate Camera FFmpeg plugin, Python bridge, vendor library, auxiliary
container, port forwarding or Homebridge Insecure Mode is required.

## Manual installation

Install this prerelease from a GitHub Release or a local `.tgz` package. It has
not been published to the public npm registry. Use the installation method that matches your Homebridge
setup; do not install it only on your computer if Homebridge runs on another host.

### Install directly from GitHub (recommended)

Downloaded release packages include the compiled plugin and custom UI. They do
not require TypeScript or a GitHub account on the Homebridge host.

On a standard Homebridge host:

```sh
npm install -g https://github.com/italofialho/homebridge-intelbras-cloud/releases/download/v0.1.0-beta.7/homebridge-intelbras-cloud-0.1.0-beta.7.tgz
```

For the official Docker container, run on the Docker host:

```sh
docker exec homebridge npm install --prefix /homebridge https://github.com/italofialho/homebridge-intelbras-cloud/releases/download/v0.1.0-beta.7/homebridge-intelbras-cloud-0.1.0-beta.7.tgz
docker restart homebridge
```

Or run the `npm install --prefix /homebridge ...` command inside **Homebridge UI →
Terminal**, then restart Homebridge from the UI. For a standard host, restart with
its UI or `sudo hb-service restart`. Continue with **Configure the DVR** below.

Source installation is also supported (requires Git and builds TypeScript during
installation):

```sh
npm install -g github:italofialho/homebridge-intelbras-cloud#v0.1.0-beta.7
```

Use a tagged release for reproducible installs. Check the
[release notes](https://github.com/italofialho/homebridge-intelbras-cloud/releases)
before updating and keep a Homebridge backup. Updating an existing installation
preserves its configuration; keep device IDs unchanged to preserve identities.

### 1. Obtain or build a local package

If you already have `homebridge-intelbras-cloud-0.1.0-beta.7.tgz`, continue to the
next step. To build it from the plugin source directory:

```sh
cd /path/to/homebridge-intelbras-cloud
npm ci
npm pack
```

Run `npm test` before packaging. `npm pack` builds the plugin and creates the `.tgz` in the current directory.
For the shared local Homebridge workspace, `npm run pack:local` writes this package
to `../dist` and preserves the other plugin packages.

### 2A. Install on a standard Homebridge host

Copy the package to the machine running Homebridge. Install it globally using the
same Node.js/npm installation that Homebridge uses:

```sh
npm install -g /absolute/path/homebridge-intelbras-cloud-0.1.0-beta.7.tgz
```

Use `sudo` only if your Homebridge installation requires it. Restart Homebridge
from its UI, or use `sudo hb-service restart` if it is managed by `hb-service`.
The startup log should contain:

```text
Loaded plugin: homebridge-intelbras-cloud@0.1.0-beta.7
Registering platform 'homebridge-intelbras-cloud.IntelbrasCloud'
```

### 2B. Install in the official Homebridge Docker container

The example below uses a container named `homebridge` and its persistent
`/homebridge` directory. Replace the container name if yours is different.
Run these commands on the Docker host, where the `.tgz` is located:

```sh
docker exec homebridge mkdir -p /homebridge/plugin-packages
docker cp /absolute/path/homebridge-intelbras-cloud-0.1.0-beta.7.tgz homebridge:/homebridge/plugin-packages/
docker exec homebridge npm install --prefix /homebridge /homebridge/plugin-packages/homebridge-intelbras-cloud-0.1.0-beta.7.tgz
docker restart homebridge
```

Keeping the package under the persistent Homebridge directory also preserves the
local package reference for future npm installs. Installing only on the Docker host
will not install the plugin inside the container.

If the package is already available inside the container, you can instead run this
in **Homebridge UI → Terminal**:

```sh
npm install --prefix /homebridge /homebridge/plugin-packages/homebridge-intelbras-cloud-0.1.0-beta.7.tgz
```

Then restart Homebridge from the UI. Before updating a working installation, keep a
Homebridge backup and the previous package for rollback.

### 3. Configure the DVR

Open **Plugins → Homebridge Intelbras Cloud → Settings**. In the **Settings** tab:

1. Add a DVR and choose a unique, stable device ID. Keep this ID after pairing.
2. Choose **Cloud connection using a serial number** or **Direct connection using
   an IP address**.
3. Enter the DVR serial number or IP/hostname and the DVR username/password.
4. Add the channels you want to expose, or leave the channel list empty to discover
   all channels. Channel numbers start at 1. Each channel can have its own name.
5. Start with **Secondary — lighter stream (recommended)** and video conversion
   disabled. Enable HomeKit Secure Video explicitly for each channel where needed.
6. Save the configuration and restart Homebridge to apply camera changes.

Use **Diagnostics → Connect and discover channels** to inspect channel names,
codecs, resolution/FPS and firmware, and to request a snapshot.

You can also edit Homebridge's `config.json` manually. Add this object to the
existing `platforms` array; replace every credential placeholder:

```json
{
  "platform": "IntelbrasCloud",
  "name": "Intelbras Cloud",
  "devices": [
    {
      "id": "my-dvr",
      "name": "Home DVR",
      "mode": "cloud",
      "serial": "YOUR_DEVICE_SERIAL",
      "username": "YOUR_DEVICE_USERNAME",
      "password": "YOUR_DEVICE_PASSWORD",
      "timezone": "America/Sao_Paulo",
      "channels": [
        {
          "id": 1,
          "name": "Entrance",
          "stream": "secondary",
          "hksv": false,
          "transcode": false
        }
      ]
    }
  ]
}
```

For a direct connection, use `"mode": "direct"` and `"host": "192.0.2.10"` instead
of `serial`. DVR HTTP and RTSP ports default to 80 and 554. Set `httpPort` and
`rtspPort` only if your DVR uses different ports. Internal proxies bind to
`127.0.0.1` on dynamically allocated ports.

### 4. Pair cameras in Apple Home

After Homebridge starts, open **Apple Home → Add Accessory → More Options** and
select each new camera. Use the setup code of the Homebridge instance publishing
it. Each channel is an external accessory and must be added separately.

Start with one channel. Confirm its snapshot, live video and motion sensor before
adding the remaining channels. Keep your previous camera setup available until
testing is complete. When migrating from another plugin, new cameras need pairing;
existing camera IDs from that other plugin are not imported automatically.

## Camera video and conversion

- **Secondary:** lower bandwidth and processing requirements; recommended for
  Apple Home. H.264 is forwarded without video re-encoding by default.
- **Primary:** uses the DVR's main video quality, which can have higher resolution.
  H.265 requires explicitly enabled conversion for Apple Home.
- **Allow video conversion for Apple Home:** permits FFmpeg to convert incompatible
  video. This consumes additional CPU. Only one video conversion runs at a time,
  shared across live viewing, HKSV and the history UI on the same host/user.

The codec is checked before a session starts. DVR encoding, recording, clock and
network settings are never changed by the plugin. Live viewing is video-only in
this release. Snapshots use direct DVR JPEG requests, a three-second cache and
coalesced concurrent requests. Apple Home controls snapshot refresh timing; its
overview is not a continuous live mosaic.

## HomeKit Secure Video

Enable `hksv` per channel, then configure recording in Apple Home. HKSV requires a
compatible Home Hub and the appropriate Apple/iCloud setup. The plugin maintains
a bounded in-memory prebuffer only while recording is enabled. Apple handles
analysis and iCloud storage; old DVR recordings are not imported into Apple's
recording timeline.

The Home Hub negotiates the recording format. Source resolution, bitrate, profile
or keyframe interval incompatibilities may require explicit video conversion.
The prebuffer is limited to 32 MiB per channel. Recording audio follows the Home
Hub's audio setting; AAC audio conversion also uses processing power. A working
recording delegate is not by itself proof of a playable iCloud timeline clip.

## DVR recording history

Open **History**, connect to the DVR, select a channel and search a date/time range.
All times are **DVR local time**. The configured IANA time zone is informational;
the plugin does not silently convert the requested range to UTC.

Results are paginated, with up to 100 entries per page. The timeline shows the
current page's intervals. Select a clip up to five minutes and 32 MiB for playback
or MP4 export. Compatible H.264 is remuxed; incompatible video requires explicit
conversion. History playback/export is video-only in this release.

Clips are buffered in memory and returned through the authenticated Homebridge UI
session. There is no additional public media server or duplicate continuous local
recording. The tested DVR returned HTTP 400 for some empty-history queries; the
plugin reports this device error rather than silently treating it as an empty page.

## Troubleshooting

| Symptom                              | Check                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Plugin is missing from Homebridge    | Install in Homebridge's own host/container and npm location, then restart.                                 |
| Settings do not open                 | Reload Homebridge UI and confirm the installed package includes `homebridge-ui/public/index.html`.         |
| Cloud connection fails               | Check the serial, network reachability and support for T2U CONNECT. Relay/UDP fallback is not implemented. |
| Authentication fails                 | Use the DVR's device credentials and permissions, not a Homebridge or cloud-portal login.                  |
| Video is incompatible                | Use secondary H.264, or explicitly allow conversion.                                                       |
| Conversion limit reached             | End the other conversion session or use a compatible H.264 source.                                         |
| History times do not match           | Enter the local time shown by the DVR.                                                                     |
| Empty-history query returns HTTP 400 | This is a known compatibility limitation of the tested DVR API.                                            |

Unavailable device initialization is retried every 30 seconds. Tunnels and motion
connections reconnect after failures. See [validation](docs/VALIDATION.md) for
remaining network-loss, sustained-load and Apple Home checks.

## Development and security

```sh
npm ci
npm test
npm run build
```

Use synthetic fixtures only. Keep credentials in private Homebridge configuration;
do not commit serial numbers, passwords, pairing data or camera images. The plugin
omits credentials/URLs from logs, but host administrators can inspect FFmpeg's
authenticated URL in process arguments. Report security issues privately to the
maintainer before opening a public issue.

Apache-2.0. See [NOTICE](NOTICE) and [upstream attribution](docs/UPSTREAM.md).
