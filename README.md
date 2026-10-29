# Floating Transcript Extension

A Manifest V3 extension for Chrome and Cốc Cốc on desktop that displays YouTube captions over other browser tabs. Move and resize the overlay, adjust the font size and background opacity, and keep following the video while working on another website.

The extension uses captions provided by YouTube. It runs locally without a separate server, account, or AI service.

The interface follows the browser's UI language: Vietnamese or English, with English as the fallback for other languages. This does not change the video's caption language.

## Installation

1. Download or clone the project and keep its folder on your computer.
2. Open `chrome://extensions` in Chrome or `coccoc://extensions` in Cốc Cốc.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project root containing `manifest.json`. Select the root folder, not `src/`.
5. Pin the extension to the toolbar for quick access.

After updating the project, reload the extension from the extensions page and refresh the YouTube and destination tabs.

## Usage

1. Open a regular YouTube video at `https://www.youtube.com/watch?v=...`.
2. Enable **CC** and confirm that captions appear in the video.
3. Open the extension and click **Enable floating subtitles from this tab** (or its Vietnamese equivalent).
4. Select an available caption language if needed.
5. Switch to another website. The captions appear over that page and update as the video plays.

Hover over the overlay to reveal its controls:

- Drag the move handle to reposition it.
- Drag the right edge to change its width.
- Use **A−** and **A+** to adjust the font size.
- Click **✕** to stop the caption session.

The control panel also lets you change background opacity and restore the default layout. Display settings are saved between sessions. Clicks pass through the caption text to the underlying page; the controls and resize handle receive mouse input.

If the toolbar popup does not open, use **Details → Extension options** on the extensions page, or press **Ctrl+Shift+Y** (**Command+Shift+Y** on macOS). The control panel opens in a separate tab where you can select the source YouTube video. Shortcut assignments can be changed on the browser's extension shortcuts page.

Only one source video is followed at a time. Starting from another YouTube tab replaces the source. Returning to the source tab hides the overlay, and closing that tab ends the session. Start a new session after restarting the browser.

The overlay works on ordinary HTTP and HTTPS pages. Browsers block injection on protected pages, including New Tab, `chrome://extensions`, `coccoc://extensions`, browser settings, and extension stores. The extension supports regular videos with available captions; livestreams, Shorts, speech recognition, and automatic translation are outside its current scope.

## Permissions and Data

| Permission | Purpose |
| --- | --- |
| `storage` | Save display preferences and temporary caption-session data. |
| `scripting` | Initialize scripts in existing tabs when a session starts or the active tab changes. |
| HTTP/HTTPS site access | Display the overlay on destination websites and access the YouTube source. |

Display preferences are stored in `chrome.storage.local`. Source metadata, caption data, and playback state are stored temporarily in `chrome.storage.session`.

The YouTube adapter reads caption responses from `/api/timedtext`. When timed caption data is unavailable, it reads the rendered CC text and keeps the caption renderer updating while the source tab is in the background. Caption request URLs and tokens are not forwarded to destination tabs.

Destination scripts render the overlay and do not collect the page's content. The extension includes no analytics and sends no data to an external application server or AI service. Caption requests go to YouTube.

The overlay is inserted into the destination page's DOM. Shadow DOM provides style isolation, not a security boundary.

## Project Structure

```text
.
├── manifest.json                 # Extension configuration and entry points
├── package.json                  # Development commands
├── README.md
├── _locales/
│   ├── en/messages.json          # English interface strings
│   └── vi/messages.json          # Vietnamese interface strings
├── src/
│   ├── background/
│   │   └── background.js         # Session management and tab messaging
│   ├── content/
│   │   ├── overlay.js            # Caption overlay and interactions
│   │   └── source.js             # Source video tracking and CC extraction
│   ├── popup/
│   │   ├── popup.html            # Shared popup and control-panel page
│   │   ├── popup.css
│   │   └── popup.js
│   ├── shared/
│   │   ├── core.js               # Caption parsing, timing, and settings
│   │   ├── i18n.js               # Browser UI language and message helpers
│   │   └── runtime.js            # Content-script lifecycle management
│   └── youtube/
│       ├── youtube-background.js # Background CC rendering support
│       └── youtube-bridge.js     # YouTube player and caption adapter
├── tests/
│   ├── unit/                     # Logic and lifecycle tests
│   └── browser/                  # Overlay and unpacked-extension tests
├── scripts/
│   └── check.cjs                 # Syntax and resource-path checks
└── docs/                         # Development and troubleshooting references
```

The scripts in `src/content/` run in the extension's isolated world. The YouTube adapters run in the page's main world. The service worker routes caption data from the source to destination tabs.

## Development

Install Node.js and run commands from the project root. No dependency installation or build step is required: the browser loads the extension directly from `manifest.json` and `src/`.

```sh
npm test                 # Run unit tests
npm run check            # Validate syntax, manifest resources, and script paths
npm run test:browser     # Test overlay rendering and interactions
npm run test:extension   # Test the installed extension with YouTube fixtures
```

Browser tests require an installed browser and a Node.js version with the global `WebSocket` API. They use a separate temporary profile rather than your personal browsing profile. Set `CHROME_PATH` if the browser is not at the default Chrome installation path. For example, in PowerShell:

```powershell
$env:CHROME_PATH = 'C:\Program Files\CocCoc\Browser\Application\browser.exe'
npm run test:extension
```

Additional extension test scenarios:

```sh
npm run test:extension -- --native-caption      # Native caption response capture
npm run test:extension -- --dom-caption         # Rendered CC fallback
npm run test:extension -- --reload-extension    # Context cleanup and reinstallation
npm run test:extension -- --background-caption  # Updates while YouTube stays hidden
npm run test:extension -- --replace-caption     # Replace old captions and clear gaps
npm run test:extension -- --action-popup        # Open and use the toolbar popup
npm run test:extension -- --ui-language=en      # English interface
npm run test:extension -- --ui-language=vi      # Vietnamese interface
npm run test:extension -- --missing-i18n        # Recover missing localization dependencies
```

These tests use sample YouTube responses. For an optional live-network check:

```sh
npm run test:extension -- --live https://www.youtube.com/watch?v=VIDEO_ID
```

Live checks depend on YouTube returning usable captions and may fail in headless sessions. Verify playback, seeking, language selection, background updates, and caption replacement with real videos on both Chrome and Cốc Cốc before releasing changes.
