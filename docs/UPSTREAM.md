# Source provenance

Camera FFmpeg reference: `vendor/streamingDelegate.ts`, commit
`7522d924bedf922b3a7a4d71d35eb722dd3d790e`, Apache-2.0.
Adaptation: `src/camera.ts` uses the prepare/start/stop lifecycle, SSRC/key
negotiation, supported profiles and FFmpeg SRTP output structure; it replaces
string-based commands with argument arrays, snapshots with authenticated DVR JPEG,
and owns socket/process cancellation. It is bundled, not a runtime plugin dependency.

Cloud protocol: independent TypeScript port of the previous locally validated
standard-library discovery/CONNECT implementation. Supports the T2U CONNECT
endpoint, not all Intelbras P2P/relay protocols. TEA is little endian, 32 rounds.
Reply source addresses, message identifier, length, serial and endpoint are checked.
Responses contain their own header/key; no unverified transaction echo is assumed.
No packet captures or private identifiers are distributed.

Primary API references:
- https://developers.homebridge.io/interfaces/CameraStreamingDelegate.html
- https://developers.homebridge.io/interfaces/CameraRecordingDelegate.html
- https://github.com/homebridge/plugin-ui-utils
