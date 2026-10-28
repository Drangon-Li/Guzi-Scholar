# Guzi Scholar

A local-first academic PDF reader that brings paper organization, continuous reading and translation, annotations, notes, and vocabulary review into one desktop app.

Your papers and reading work stay on your device by default. Connect your own API services for translation and article assistance.

[Download](https://github.com/Drangon-Li/Guzi-Scholar/releases) · [Try the browser demo](https://scholar.guzilab.com/) · [中文](README.md)

![Continuous reading and translation in Guzi Scholar](docs/images/reading.jpg)

*Screenshot from the browser demo using the public “Attention Is All You Need” sample. AI translations and answers are preset examples, not live model results; no private library is shown.*

## A workflow for reading papers

### 1. Organize your library

Import PDFs and organize them with folders, reading status, custom properties, and filtered views. Keep track of what to read next and what you have already read.

![Paper library and reading status](docs/images/library.jpg)

*Screenshot from the browser demo using the public “Attention Is All You Need” sample. AI translations and answers are preset examples, not live model results; no private library is shown.*

### 2. Read continuously, with translation when needed

Convert PDFs into continuous reading pages, navigate the outline, and adjust text size and spacing. Translate selected text or the full article, and ask the reading assistant questions about the paper. Translation caches are saved locally for later reading.

The desktop package includes local conversion tools. You can optionally connect a self-hosted GLM-OCR + MinerU parsing service for complex layouts. Conversion quality depends on the source PDF and parsing engine. AI translation and assistance require your own configured services.

### 3. Keep annotations and notes

Highlight passages, add comments, and collect questions and conclusions in article notes, including images. Personal annotations and AI reading highlights are stored separately so you can distinguish your own records from model suggestions.

![Article notes and annotations](docs/images/notes.jpg)

*Screenshot from the browser demo using the public “Attention Is All You Need” sample. AI translations and answers are preset examples, not live model results; no private library is shown.*

### 4. Review vocabulary in context

Save words and phrases from the original text with their source sentences and papers. Edit meanings, tags, and notes, review entries by learning status, and return to the paper to see how a term is used.

![Vocabulary with source sentences and papers](docs/images/vocabulary.jpg)

*Screenshot from the browser demo using the public “Attention Is All You Need” sample. AI translations and answers are preset examples, not live model results; no private library is shown.*

## Try it in your browser

**[Open the browser demo → scholar.guzilab.com](https://scholar.guzilab.com/)**

Explore a public sample paper with the reading sidebar, notes, annotations, and vocabulary tools. Edits stay in your current browser, persist after refresh, and can be reset.

AI answers and translations are clearly labeled preset examples; no live model is called. Loading the site and sample requires an internet connection. Use the desktop app for PDF uploads, reparsing, Zotero imports, and real AI services.

## Downloads and platforms

Download desktop packages from [Releases](https://github.com/Drangon-Li/Guzi-Scholar/releases).

| Platform | Packages | Status |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` for installation; `.zip` for in-app updates | Actively maintained; not notarized |
| Windows x64 | `.exe` / `.zip` | Updates at selected key releases aligned with major release plans; existing packages remain in historical Releases |

macOS is the primary platform for development and releases, including routine feature work, local testing, and default CI validation.

**Routine Windows iteration is paused, but Windows development is not discontinued.** Adaptation, testing, and releases will be planned around major release goals, with updates at selected key releases rather than every macOS minor release. Windows source and manual build entry points remain available.

The macOS package bundles Python, Java, Pandoc, OpenDataLoader, and PyMuPDF runtimes. It uses ad-hoc signing and has not been signed with an Apple Developer ID or notarized by Apple. If Gatekeeper blocks the first launch, right-click `谷子学术.app` in Finder, choose **Open**, and confirm the prompt.

The app checks for updates at startup and supports manual checks. Sparkle verifies the update signature before installation. You can also download a DMG for a manual update.

## Get started

1. Install the desktop app, import a PDF, and wait for local conversion.
2. Configure the service URL, API key, and model for translation and the article assistant in Settings. The services can be configured separately and support OpenAI-compatible APIs and other formats offered in the UI. The app does not include provider keys or a large language model.
3. Open a paper to read, translate, annotate, take notes, and save vocabulary. Library management, reading converted content, annotations, and local notes remain available without an AI service.

## Data and privacy

PDFs, translations, notes, annotations, vocabulary, settings, and AI configuration are stored on your device by default. The installed app keeps application state and the paper library separately; you can choose a library location in Settings.

Some optional features send data outside your device:

- Online metadata lookup sends paper identifiers, titles, or author candidates to the relevant public services.
- Translation, article assistance, and AI-assisted vocabulary explanations send the relevant text, article context, or explicitly attached images to your configured services.
- Remote parsing uploads the original PDF to your configured server. Downloaded results are saved locally.

Do not commit API keys, user data, `data/`, `developer.tokens.json`, or local build artifacts to Git.

## Remote parsing

Remote GLM-OCR + MinerU parsing is optional and requires your own Linux NVIDIA GPU server. The desktop download does not include a public parsing service, credentials, or GPU model weights. Translation and article-assistant API settings are separate from the parsing service settings.

See the [complete remote server setup guide](README.md#远端解析服务器配置) for SSH connection fields, host verification, the private `remote-parser.config.json` file, configuration precedence, deployment prerequisites, and troubleshooting. The guide includes the full connection example and server deployment steps.

## Development

```sh
npm ci
npm --prefix apps/desktop ci
npm run desktop:dev
```

Common checks and build commands:

```sh
npm run desktop:check:syntax
npm run desktop:check
npm run build:mac
```

Shared desktop source and tests live in [`apps/desktop/`](apps/desktop/); platform packaging lives in [`platforms/`](platforms/). See the [desktop development guide](apps/desktop/README.md) for runtime requirements, data directories, and configuration.

Runtime and UI acceptance default to macOS; shared static checks may run on Linux CI. Default releases build macOS artifacts and require matching signatures, asset verification, and native upgrade acceptance. The macOS release workflow prepares bundled runtimes and currently uses ad-hoc signing. Windows CI is manual-only; Windows candidates included in a major release plan must pass Windows build and native upgrade acceptance before publication. The `build:windows` and `verify:windows` commands remain available for that work.

## License and contributions

Project-owned code is licensed under [Apache License 2.0](LICENSE). Preserve the source attribution in [NOTICE.md](NOTICE.md) when redistributing or creating derivatives, and follow the separate terms for third-party dependencies, fonts, icons, and paper content.

Issues and pull requests are welcome. For platform packaging changes, include the target OS, architecture, installation method, and validation results.
