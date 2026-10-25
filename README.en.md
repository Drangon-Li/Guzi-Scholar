# Guzi Scholar

Guzi Scholar is a local-first academic PDF reader for managing papers, structured reading, translation, annotations, notes, and article assistance in one desktop application.

The open-source desktop distribution targets macOS and Windows with one shared desktop codebase. The macOS package is available first; Windows packages will follow after real-machine verification.

## Online demo

**[Try the browser demo → scholar.guzilab.com](https://scholar.guzilab.com/)**

Explore a public sample paper with the full reading sidebar, notes, annotations, and vocabulary tools—no installation required. Edits stay in your current browser, persist after refresh, and can be reset.

AI answers and translations are clearly labeled, preset examples; no live model is called. Loading the site and sample requires an internet connection. Use the desktop app for PDF uploads, reparsing, and Zotero integration.

## English documentation coming soon

The complete English README, installation guide, privacy notes, and contributor documentation are still being prepared. For now, please read the [Chinese README](README.md) and the platform notes in `apps/desktop/` and `platforms/windows/`.

The project code is licensed under [Apache License 2.0](LICENSE). Third-party dependencies and bundled assets may have additional license and notice requirements.

## Downloads

Download the latest macOS Apple Silicon DMG from the [Releases](https://github.com/Drangon-Li/Guzi-Scholar/releases) page. The current macOS package is the `v0.4.0` GitHub release: it uses ad-hoc signing and has not been signed with an Apple Developer ID or notarized by Apple. If Gatekeeper blocks the first launch, right-click `Guzi Scholar.app` in Finder, choose **Open**, and confirm the prompt. Updates are manual downloads from the Releases page; reliable in-app automatic replacement is not promised. Windows packages are coming after real-machine verification.

## Development

```sh
npm ci
npm --prefix apps/desktop ci
npm run desktop:dev
```

The shared desktop source lives in `apps/desktop/`. Platform packaging and launch configuration lives in `platforms/`. Please see [README.md](README.md) for the current feature list, requirements, data model, and contribution notes.

## Remote parsing

Version 0.3.0 can connect to a self-hosted GLM-OCR + MinerU parsing service. The desktop download does not include a public service, credentials, or GPU models. PDFs are uploaded to your configured server; parsed results remain stored locally. See the [remote server setup guide](README.md#远端解析服务器配置) for connection fields, the private configuration file, SSH host verification, deployment prerequisites, and troubleshooting. Translation API credentials are configured separately.
