# Spec 25 — Boot Resilience

## Problem

After a Mac reboot, the launchd service (`agentcore install`) starts the agentcore node process via `RunAtLoad=true`. That process calls `ContainerLauncher.ensureSystemRunning()`, which runs `container system start`. The Apple container system daemon takes variable time to initialize post-reboot — often longer than a single 30-second `execSync` call allows. Because there is no retry logic:

1. `container system start` fails or times out → exception thrown → node process crashes.
2. `KeepAlive: true` in the plist causes launchd to restart the process, but without `ThrottleInterval` the rapid crash-restart cycle can trigger launchd's internal back-off, causing it to throttle or stop retrying.

**Observed symptom**: agent never comes up after a Mac reboot even though `agentcore install` was run.

## Design

### `ContainerLauncher.ensureSystemRunning()` — retry loop

Replace the single-attempt call with a polling loop that retries up to ~60 seconds total:

- Try `isSystemRunning()` first (fast check, returns immediately if already up).
- Attempt `container system start` (30s timeout, stdio ignored so logs don't pollute stderr on boot).
- After `start`, wait 2s and re-check `isSystemRunning()`.
- If still not up, sleep 5s and retry. Up to 12 attempts (~60s total window).
- If all attempts exhausted, throw with a descriptive error message.

Uses `Atomics.wait` for synchronous sleep (consistent with the synchronous `execSync` patterns already used throughout the file).

### `LaunchdInstaller` plist — `ThrottleInterval`

Add `ThrottleInterval = 10` (seconds) to the generated plist. This ensures launchd waits at least 10 seconds between restarts, preventing rapid crash loops from triggering its internal back-off that could halt retries entirely.

Default launchd throttle is 10s already in modern macOS, but making it explicit in the plist ensures consistent behaviour across OS versions and prevents the plist from being treated as a "crashing" job.

### Reinstall note

`ThrottleInterval` only takes effect in newly generated plists. Users with an existing install need to reinstall:

```
agentcore uninstall && agentcore install
```

`agentcore install` already errors out if the service is installed (directing users to uninstall first), so no additional UX change is needed.

## Affected components

| File | Change |
|------|--------|
| `src/container/container-launcher.js` | Retry loop in `ensureSystemRunning()` |
| `src/container/launchd-installer.js` | Add `ThrottleInterval` to plist template |

## Testing

1. Stop the container system: `container system stop`
2. Run `node bin/agentcore.js start` — should log retry warnings and eventually succeed, not crash immediately.
3. Reinstall the launchd service and inspect the plist:
   ```
   agentcore uninstall && agentcore install
   cat ~/Library/LaunchAgents/com.boris.agentcore.plist
   ```
   Confirm `ThrottleInterval` key is present with value `10`.
4. Reboot Mac, wait ~90 seconds, then run `agentcore status` — should return healthy.
