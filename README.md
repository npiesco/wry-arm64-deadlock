# wry ARM64 WebView2 Deadlock  Minimal Reproducible Example

## Bug summary

On **Windows ARM64** (Snapdragon X Elite / X Plus), creating a new
`WebView2` controller while the main webview's message loop is already
running causes an **infinite deadlock** inside wry's `wait_with_pump()`.

The root cause is that `MsgWaitForMultipleObjectsEx`  used by wry to
pump messages while waiting for WebView2 initialization  does **not**
dispatch COM callbacks on ARM64.  The `CreateCoreWebView2Controller`
completion handler is a COM callback, so it never fires and `.build()`
never returns.

### Affected versions

| Crate | Version | Status |
|-------|---------|--------|
| wry   | 0.54.x  |  Deadlocks on ARM64 |
| tauri | 2.x     |  (uses affected wry) |

### Not affected

- x86-64 Windows (native or emulated)
- macOS / Linux

## Reproduction steps

### Prerequisites

- Windows ARM64 device (Snapdragon X Elite, X Plus, etc.)
- Rust toolchain (`rustup` with `aarch64-pc-windows-msvc`)
- Node.js  18

### Steps

```bash
git clone https://github.com/npiesco/wry-arm64-deadlock.git
cd wry-arm64-deadlock
npm install
npx tauri build --debug
# Launch the exe from src-tauri/target/debug/
```

1. Click **Go** (loads `example.com` in a child WebView2 window)
2. Change the URL in the address bar
3. Click **Go** again

Step 3 calls `navigate_tab` which does:
```rust
browser_win.close();
WebviewWindowBuilder::new(&app, &SAME_LABEL, url).build()  //  DEADLOCKS
```

The status bar turns **red** after 5 seconds:
> **DEADLOCK DETECTED  .build() has not returned**

The app must be killed via Task Manager.

## Branches

### `main`  reproduces the deadlock

Uses **upstream wry 0.54.x**.  The `.build()` call in `navigate_tab`
deadlocks on ARM64 because `MsgWaitForMultipleObjectsEx` never
dispatches the `CreateCoreWebView2Controller` COM callback.

### `fix/vendored-wry-tauri`  deadlock resolved

Uses vendored forks:

| Fork | Branch | What it fixes |
|------|--------|---------------|
| [npiesco/wry](https://github.com/npiesco/wry/tree/fix/deferred-webview2-arm64) | `fix/deferred-webview2-arm64` | Replaces `MsgWaitForMultipleObjectsEx` with `CoWaitForMultipleHandles` using `COWAIT_DISPATCH_CALLS \| COWAIT_DISPATCH_WINDOW_MESSAGES` |
| [npiesco/tauri](https://github.com/npiesco/tauri/tree/fix/deferred-webview2-creation) | `fix/deferred-webview2-creation` | Adds a response channel to `Message::CreateWindow` so the caller blocks until the HWND is ready (prevents race conditions) |

The fix branch also shares the main window's `ICoreWebView2Environment`
with child windows via `.with_environment()` (required by the tauri
fork's stricter error surfacing).

## Technical details

### The deadlock

```
Main thread                         COM thread pool
                        
WebviewWindowBuilder::build()
   wry::webview::create()
     CreateCoreWebView2Controller(callback)
     wait_with_pump()
       MsgWaitForMultipleObjectsEx(event)
         WAIT_OBJECT_0+1 (messages)   CreateController completes
         PeekMessage / DispatchMessage    callback needs to run on
         loop forever                       main thread via COM
                                             BLOCKED: main thread is
                                              in MsgWaitForMultiple...
                                              which doesn't dispatch
                                              COM calls on ARM64
```

### The fix (wry)

Replace `MsgWaitForMultipleObjectsEx` with `CoWaitForMultipleHandles`:

```rust
// Before (deadlocks on ARM64):
MsgWaitForMultipleObjectsEx(1, &raw const event, INFINITE, QS_ALLINPUT, 0);

// After (works on ARM64):
CoWaitForMultipleHandles(
    COWAIT_DISPATCH_CALLS | COWAIT_DISPATCH_WINDOW_MESSAGES,
    INFINITE, &[event],
);
```

`CoWaitForMultipleHandles` with `COWAIT_DISPATCH_CALLS` properly enters
a COM modal loop that dispatches both window messages AND COM callbacks,
which is exactly what's needed while waiting for WebView2 initialization.

### The fix (tauri)

The upstream `create_window` handler in `tauri-runtime-wry` is
fire-and-forget  it sends `Message::CreateWindow` but never waits for
confirmation.  The fork adds a `Sender<Result<()>>` to the message so
`.build()` blocks until the window is actually created (or returns an
error).  This prevents HWND races where code tries to use a window
handle before Windows has finished creating it.

## License

MIT  same as wry and tauri.