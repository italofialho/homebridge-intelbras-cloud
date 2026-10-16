# Compatibility matrix

| Device / environment | Protocol evidence before plugin | Plugin status |
|---|---|---|
| Intelbras MHDX 3108 | Prior Python T2U CONNECT + RTSP/JPEG probes | Node Cloud: 8 channels/JPEG, motion, history and playback confirmed; Apple Home pending |
| Firmware tested | MHDX 3108: 4.000.00IB002.17, build 2021-10-18 | Other firmware unverified |
| Other Intelbras DVRs | None | Capability detection only; unsupported until tested |
| Cloud T2U CONNECT | Discovery + TCP CONNECT | Implemented; loopback dynamic proxies |
| Cloud relay / other P2P | None | Unsupported; explicit diagnostic |
| Direct LAN HTTP Digest + RTSP | Synthetic test servers | Implemented; real LAN validation pending |
| Homebridge 1.8 / 2.x | TypeScript API compile | 2.4.0 starts one external camera; pairing/HKSV timeline pending |
| Linux ARM64 | Target Raspberry | Package installed, 18 tests pass; real-source recording delegate verified |

Do not infer compatibility from brand or model family. Model, firmware, transport,
codecs, events, recording APIs, browser playback and Apple Home must be validated
individually. Firmware is read dynamically and never changed.
