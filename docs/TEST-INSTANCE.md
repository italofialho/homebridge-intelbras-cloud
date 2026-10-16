# Isolated Homebridge testing

Use a separate Homebridge storage directory and stable device ID when testing the
plugin alongside an existing installation. Keep the production configuration and
camera accessories available until the new cameras have been checked in Apple Home.

## Prepare a test instance

1. Build and install the local package as described in [README](../README.md).
2. Create a separate Homebridge storage directory with its own `config.json`.
3. Give the test bridge a unique name, HomeKit username, setup code and port. Do not
   copy the production bridge identity or its pairing storage.
4. Configure `IntelbrasCloud` with a distinct device ID and one channel. Use the
   secondary stream and keep conversion disabled initially. Protect credentials
   in the private configuration file, with file mode 0600 where supported.
5. Start Homebridge with the test storage path and plugin path:

```sh
homebridge -U /path/to/test-storage -P /path/to/homebridge-intelbras-cloud --strict-plugin-resolution
```

The plugin path should point to the installed/built package. Use the Homebridge
binary and Node.js version of the environment where you installed the plugin.
A test instance does not need Homebridge Insecure Mode.

## Verify before migration

- Pair the external camera in Apple Home using the test instance's setup code.
- Check snapshots, live video, cancellation and physical motion-to-channel mapping.
- If testing HKSV, enable it for the channel and activate recording in Apple Home.
  Verify a playable timeline clip, prebuffer, audio settings and restart recovery.
  An MP4 fragment produced by the delegate is a separate validation step.
- Enable video conversion explicitly if the Home Hub requires a format that the
  source cannot provide directly. Check CPU use and the shared conversion limit.
- Expand to the remaining channels after the one-channel check, then measure
  CPU, memory, latency and recovery over a 24-hour test.
- Test the authenticated Homebridge UI diagnostics, history search and browser
  playback/export separately from the Apple Home camera view.

## Stop or roll back

Stop only the isolated Homebridge process. Remove only its test cameras from Apple
Home if they were paired. Keep the production storage, original camera platform
and any required transport services intact until migration is explicitly performed.

Back up the production configuration and pairing storage before migration.
Changing a device ID creates a different accessory identity; keep it stable after
pairing. Replacing a different camera plugin generally requires adding the new
external cameras in Apple Home and removing the old accessories after validation.

## Local validation history

The initial isolated ARM64 test instance was stopped after the user approved an
eight-channel migration on 2026-10-15. The old camera platform and transport
containers were then disabled, and all eight native-plugin channels passed JPEG
and H.264 video probes without those services. This does not replace the remaining
HKSV timeline and sustained-load checks listed in [VALIDATION.md](VALIDATION.md).
