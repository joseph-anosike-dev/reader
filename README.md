# Reader

Reader is a lightweight text-to-speech reading app designed to turn notes, articles, and imported documents into a sentence-by-sentence listening experience. It started as a simple way to load text and press play, and over time it evolved into a more polished reading companion with mobile-friendly playback controls, content parsing, persistent history, and Android-native speech support.

## Why this project exists

The app was built around a simple idea: make reading easier for people who want to listen to long notes without staring at a screen. Whether someone is reviewing a draft, reading technical notes, or listening to study material, the goal is to deliver a calm, controllable reading flow with the ability to pause, rewind, loop, adjust speed, and resume where they left off.

## Version evolution since repo creation

The repository shows a clear progression from a minimal reader to a more capable personal reading experience.

### V1.0 — Foundation: load, read, and listen

The first stage focused on the core workflow:

- A setup view for pasting text or adding a file
- Support for plain text and common document inputs
- A sentence-by-sentence player UI with play, pause, previous, and next controls
- Basic speech output through the browser speech engine
- A simple text-cleaning pass to strip obvious formatting noise before reading

At this stage, the app served as a clean proof of concept: the user could bring in content and have it spoken back in a predictable, linear flow.

### V1.1 — Reading intelligence and cleaner narration

The next major jump was in how the app processed content before speech. The codebase shows a deliberate effort to make the reading experience more natural and less error-prone:

- Markdown and document formatting are stripped so raw notes sound cleaner when spoken
- Headings are preserved as section markers so long content can be navigated by topic
- Sentence splitting was improved to handle abbreviations, URLs, domain names, versions, numbers, and timestamps without incorrectly cutting the text
- Repeated punctuation and malformed spacing are normalized so the reader does not skip or merge sentences unexpectedly

This is one of the most important changes in the project: the app moved from simply reading text to understanding the structure of the text well enough to speak it more reliably.

### V1.2 — Playback control and reader ergonomics

As the app matured, the focus shifted to usability and control. The player gained the features that make a long note feel usable instead of just audible:

- Repeat the whole file
- A-B looping for focused listening
- Jump to a sentence or section
- A progress bar and estimated time remaining
- Locked-in reading position tracking for the current document
- Voice and text settings for speech preferences

These additions made the reader feel much more like a deliberate study or review tool rather than a quick demo.

### V1.3 — Voice, volume, and text personalization

The app added a more complete settings layer so each user could tune the reading experience:

- Voice selection
- Reading speed control
- Volume control
- Text size and line spacing adjustments
- Diagnostics for available speech engines

This stage reflects a move toward personalization: the reader is no longer a one-size-fits-all experience, but an adjustable listening environment.

### V1.4 — Android-native and background reading support

A major product-level enhancement appears in the code comments: the app is designed to work with Android-specific native speech infrastructure, not just the browser.

Key capabilities include:

- Native text-to-speech integration via a plugin or app bridge
- Background playback so reading continues while the screen is off or the app is minimized
- Notification and lock-screen controls
- System volume integration with the phone’s media settings
- A background player that keeps state synchronized even when the visible UI is not active

This is a major expansion beyond a browser-only utility. It signals that the repository is not just a demo reader—it is designed for real mobile reading sessions in a native app environment.

### V1.5 — Working memory and recent-document experience

The app also gained practical product features that make it feel like a daily-use tool:

- Recent files list
- Position memory for where the user stopped reading
- Automatic resume when reopening a recent document
- Local storage for reading preferences and document history
- File deduplication and retention logic so recent notes remain useful without growing indefinitely

These features turn the reader into a session-based application rather than a one-shot file player, making it much more useful for ongoing work.

### V1.6 — Navigation and content structure support

The final major evolution visible in the code is around large-document navigation:

- Section detection from Markdown headings
- Jump-to-section panel
- Scroll-aware current sentence highlighting
- Sentence-level navigation in long documents

This makes the app practical for longer content such as notes, books, articles, or research material, where linear reading alone is not enough.

## Current product profile

The current state of the repository reads as a mature single-page reading app with a strong emphasis on accessibility and focused listening. The app supports:

- Paste text or open a local file
- Read Markdown and plain text naturally
- Support PDF, Word, and PowerPoint text extraction in the Android flow
- Use browser speech or native device voice engines
- Navigate by sentence and section
- Loop or replay key text passages
- Preserve recent documents and reading progress

## Architecture snapshot

The project is implemented as a single HTML app with JavaScript logic and CSS styling:

- `Reader.html` contains the UI structure and screens
- `app.js` contains the playback engine, app state, voice integration, parsing, and persistence logic
- `style.css` defines the visual design and mobile-friendly layout

This makes the app easy to extend, test, and adapt for additional reading formats or platform integrations.

## Summary

The story of this repository is one of steady product evolution: it began as a simple text reader, grew into a cleaner and more intelligent narration tool, and then expanded into a mobile-friendly, feature-rich reading experience. The major theme across the versions is not just adding buttons, but improving how the app understands and delivers text to the user in a natural and useful way.

That progression makes the project feel like a real, usable reading companion rather than a static prototype.

## Quick start

Because this is a static front-end app, you can open `Reader.html` in a browser to use it directly. The app is designed to run with browser speech support, and the Android integration path enables richer voice and background playback features when used in the native app environment.

---

This README was written to narrate the repository’s feature evolution as reflected in the project’s current codebase and design patterns.
