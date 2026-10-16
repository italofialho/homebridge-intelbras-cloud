# Validation record

## Automated (synthetic data)

`npm test`: TEA known vector, discovery frame bounds/serial/endpoints, CONNECT
split response/refusal/cancellation, loopback proxy lifecycle, Digest construction,
recording table parsing/empty results, snapshot coalescing, one-based search
channel and cleanup on failure, MP4 chunk framing, conversion limit, configuration.

## MHDX 3108 read-only Cloud validation — 2026-10-15

Executed Node 24.21.0 inside the Raspberry ARM64 container, using the new plugin's
own transport. The current Homebridge configuration was read for private
credentials; it was not modified. No vendor binary, Python bridge or fixed proxy
port was used by the plugin.

Confirmed (18 synthetic tests also pass on both macOS and Raspberry ARM64):

- Exactly eight physical channels, names, codecs, dimensions/FPS and firmware.
  Excluded virtual encoder index 42 using ChannelTitle as the physical channel list.
- Eight direct JPEG snapshots, approximately 15–26 kB each; no images saved.
- Channel 1 secondary H.264 704×480/15 fps, primary HEVC 1920×1080/30 fps.
- Live VideoMotion Start/Stop events normalized from protocol index to channel.
  Physical scene-to-channel correspondence still requires the user's check.
- Historical search returned five intervals, with more results available; successful
  findFile/findNextFile/close/destroy. Search channels are ONE-based, unlike events.
- Playback of a recording from earlier that day: HEVC 1920×1080/30 fps detected;
  five-second copy/remux completed with exit 0 and 2,027,392 MP4 bytes, held only in
  memory. This verifies DVR playback, not HEVC support in the browser.
- Historical HEVC → H.264 browser-format conversion completed (5 seconds,
  8,564,513 bytes, exit 0, 16.874 seconds elapsed, no FFmpeg errors) with two decoder/
  encoder threads and short GOP. Same arguments used by the UI conversion path.
- Two real historical pages returned five distinct intervals each.
- Real-source recording delegate with explicit conversion generated an 833-byte
  initialization and a 76,904-byte, 2,000 ms sync fragment. No audio track was
  present; disabling recording stopped processing. This is not Apple Home HKSV
  certification or evidence of an iCloud timeline clip.
- Isolated Homebridge 2.4.0 / HAP 2.2.2 starts and publishes one external camera,
  Intelbras Test Camera 1. See TEST-INSTANCE.md for private pairing and stop/start.
- DVR CGI dates use %20; RTSP playback dates use YYYY_MM_DD_hh_mm_ss.

## Subsequent deployment and migration — 2026-10-15

- The user confirmed the first native-plugin camera test in Apple Home succeeded.
- The plugin was installed in the main Homebridge instance, then expanded to eight
  channels after explicit migration approval. The original configuration and
  pairing storage were backed up, and the first channel kept its device identity.
- All eight channels passed direct JPEG and H.264 704×480 video probes after the
  previous HTTP/RTSP/P2P transport containers were stopped. Those containers and
  the old camera platform were disabled; none is required by the new plugin.
- Home Assistant was stopped and its automatic startup was disabled separately.
- The user confirmed that the settings UI opens. UI packaging and IPC readiness
  tests were added; the full suite now contains 20 tests on macOS. The earlier
  18-test suite also passed on Linux ARM64.
- Numeric controls, native Homebridge navigation styling and clearer video choices
  were delivered. Plugin UI text and all documentation are now English.

## Remaining validation

- Full authenticated custom UI flow in Homebridge UI and actual browser playback/
  export. Historical conversion backend is verified, browser interaction is not.
- Real LAN mode, endpoint expiry/reconnection under network loss, eight-channel
  concurrent load, long live sessions and cleanup under stress.
- Empty-history queries returned HTTP 400 on the target DVR and are reported as
  device errors, not silently treated as empty. Further API compatibility work is
  required. Channels without recordings and timezone/DST edges remain unverified.
- Pair the remaining external cameras in Apple Home and verify concurrent viewer
  cancellation and recovery. The original isolated test process is stopped.
- Explicit HKSV activation, motion, prebuffer, playable timeline clip, audio disabled,
  restart recovery and Home Hub negotiated format compliance.
- Complete the 24h CPU/RSS/latency/failures/recovery measurement with all intended
  cameras paired and enabled. Individual eight-channel probes are not a sustained
  simultaneous-load test.

The read-only protocol tests did not change DVR settings. The later migration
changed only the explicitly approved Homebridge configuration and legacy transport
startup policies. Backups were retained for rollback. No public publication was
performed.

## Live-session callback regression coverage

The beta.7 fix acknowledges FFmpeg process startup separately from media readiness,
uses the discovered encoder codec instead of probing a second RTSP stream for each
view, and bounds startup acknowledgement to seven seconds. Cancellation and process
failures complete the callback exactly once and clean up the session. Regression
tests cover a blocked endpoint, cancellation, startup without progress output, and
native-only HKSV resolution advertising when conversion is disabled.

HKSV copy mode now advertises the selected source dimensions and FPS only. A Home
Hub may still request an incompatible profile, bitrate or cached configuration;
recording then fails explicitly. This does not certify an iCloud timeline clip.

A real-source loopback SRTP test then reproduced FFmpeg rejecting unsigned SSRC
values above INT32_MAX. Beta.8 passes the identical 32-bit SSRC as a signed int32
to FFmpeg, while retaining the unsigned HomeKit negotiation value. The startup
regression test includes a high-bit SSRC.

Beta.8 was tested against the real Cloud source on Raspberry ARM64 with three
sequential Channel 4 SRTP sessions, forcing SSRC 0xdeadbeef each time. Startup
callbacks completed in 44/9/10 ms; first encrypted RTP packets arrived in
5080/5137/4976 ms. Every cancellation terminated FFmpeg and removed its session.
These loopback transport checks do not replace viewing in Apple Home.
