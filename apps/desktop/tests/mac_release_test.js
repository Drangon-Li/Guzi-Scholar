'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const resources = new Map((manifest.build?.extraResources || []).map((entry) => [entry.to, entry.from]));
const expectedResourceDestinations = [
  'java',
  'licenses/Guzi-Scholar-LICENSE',
  'licenses/Guzi-Scholar-NOTICE.md',
  'licenses/opendataloader-pdf',
  'licenses/pandoc',
  'python-server',
  'toolchain/opendataloader-pdf-cli-0.0.0.jar',
  'toolchain/pandoc',
  'toolchain/pdf-renderer',
];

function walkFiles(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(directory, relative));
    else files.push(relative);
  }
  return files;
}

function readPngSize(file) {
  const image = fs.readFileSync(file);
  assert.deepStrictEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function minimalPdf() {
  const stream = 'BT /F1 12 Tf 20 100 Td 1 0 0 rg (Guzi Scholar red) Tj 0 0 1 rg ( blue) Tj 0 0 0 rg ( runtime smoke) Tj /F2 12 Tf ( bold) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `${command} failed:\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

assert.strictEqual(manifest.build?.appId, 'com.guzi.scholar');
assert.strictEqual(manifest.build?.productName, '谷子学术');
assert.strictEqual(manifest.build?.directories?.output, 'dist/mac.noindex');
assert.strictEqual(manifest.build?.mac?.extendInfo?.CFBundleDisplayName, '谷子学术');
assert.strictEqual(manifest.build?.mac?.extendInfo?.CFBundleName, '谷子学术');
assert.strictEqual(manifest.version, '0.1.12');
assert.strictEqual(manifest.build?.afterPack, 'scripts/after-pack.cjs');
assert.match(manifest.scripts?.['pack:mac'] || '', /prepare:mac/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /prepare:mac/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /build-mac-target\.cjs dmg release/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /build-mac-target\.cjs check release/u);
assert.match(manifest.scripts?.['dist:mac'] || '', /MY_SCHOLAR_RELEASE_BUILD=1 npm run prepare:mac/u);
assert.match(manifest.scripts?.['dist:mac:internal'] || '', /build-mac-target\.cjs dmg internal/u);
assert.strictEqual(resources.get('python-server'), 'build/mac-runtime/my-scholar-server');
assert.strictEqual(resources.get('java'), 'build/mac-runtime/java');
assert.strictEqual(resources.get('toolchain/opendataloader-pdf-cli-0.0.0.jar'), 'build/mac-runtime/opendataloader-pdf-cli-0.0.0.jar');
assert.strictEqual(resources.get('toolchain/pdf-renderer'), 'build/mac-runtime/pdf-renderer');
assert.deepStrictEqual([...resources.keys()].sort(), expectedResourceDestinations, 'the default package extraResources allowlist changed');
assert.ok(manifest.build?.files?.includes('*.py'), 'the small Python component catalog must be packaged with the service');
for (const [destination, source] of resources) {
  assert.doesNotMatch(`${destination}\n${source}`, /mineru|safetensors|model(?:s)?[\\/]/iu, 'MinerU runtimes and models must not enter the default package');
}
assert.strictEqual(manifest.build?.dmg?.background, 'resources/dmg-background.png');
assert.deepStrictEqual(manifest.build?.dmg?.window, { width: 720, height: 530 });
assert.strictEqual(manifest.build?.dmg?.contents?.[0]?.x, 168);
assert.strictEqual(manifest.build?.dmg?.contents?.[1]?.path, '/Applications');
assert.ok(fs.existsSync(path.join(root, 'resources', 'dmg-background.svg')), 'the branded DMG background source must be kept with the package');
assert.deepStrictEqual(readPngSize(path.join(root, 'resources', 'dmg-background.png')), { width: 720, height: 530 });
assert.deepStrictEqual(readPngSize(path.join(root, 'resources', 'dmg-background@2x.png')), { width: 1440, height: 1060 });
const dmgBackgroundSource = fs.readFileSync(path.join(root, 'resources', 'dmg-background.svg'), 'utf8');
assert.doesNotMatch(dmgBackgroundSource, /先双击.*尝试打开/u, 'the DMG must not ask users to launch the uninstalled app first');
assert.match(dmgBackgroundSource, /从“应用程序”打开“谷子学术”/u);

const afterPackSource = fs.readFileSync(path.join(root, 'scripts', 'after-pack.cjs'), 'utf8');
for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription']) {
  assert.match(afterPackSource, new RegExp(key), `${key} must be removed from the packaged Info.plist`);
}
assert.match(afterPackSource, /NSAllowsArbitraryLoads: false/u);

const buildMacSource = fs.readFileSync(path.join(root, 'scripts', 'build-mac-target.cjs'), 'utf8');
assert.match(buildMacSource, /Developer ID Application:/u);
assert.match(buildMacSource, /APPLE_KEYCHAIN_PROFILE/u);
assert.match(buildMacSource, /--config\.mac\.identity=-/u);
assert.match(buildMacSource, /--config\.mac\.hardenedRuntime=false/u);
assert.match(buildMacSource, /\.metadata_never_index/u);

const releaseWorkflow = fs.readFileSync(path.join(root, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
assert.match(releaseWorkflow, /workflow_dispatch:[\s\S]*publish_release:[\s\S]*type: boolean/u);
assert.match(releaseWorkflow, /if: github\.event_name == 'workflow_dispatch' && inputs\.publish_release == true/u);
assert.doesNotMatch(releaseWorkflow, /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/u, 'tag pushes must not publish a GitHub Release automatically');
assert.match(releaseWorkflow, /format\('refs\/tags\/\{0\}', inputs\.release_tag\)/u, 'manual publishing must checkout an exact tag ref');
assert.match(releaseWorkflow, /gh release create[\s\S]*--verify-tag/u, 'manual publishing must refuse to synthesize a missing tag');
assert.match(releaseWorkflow, /Verify packaged runtime boundary[\s\S]*mac_release_test\.js/u);
assert.match(releaseWorkflow, /Build internal macOS package[\s\S]*dist:mac:internal/u, 'tag builds must remain internal');
assert.match(releaseWorkflow, /Build ad-hoc macOS release package[\s\S]*inputs\.publish_release[\s\S]*dist:mac:internal/u, 'manual publishing must build the ad-hoc release target');
assert.doesNotMatch(releaseWorkflow, /MACOS_CSC_LINK|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID/u, 'GitHub release publishing must not imply Apple signing or notarization secrets');
assert.match(releaseWorkflow, /gh release create[\s\S]*--verify-tag[\s\S]*--notes-file release-notes\.md[\s\S]*--title "Guzi Scholar \$RELEASE_TAG"/u, 'stable releases must be verified-tag releases with explicit notes');
assert.doesNotMatch(releaseWorkflow, /gh release create[\s\S]*--prerelease/u, 'stable GitHub releases must not be marked pre-release');
assert.match(releaseWorkflow, /stable GitHub release[\s\S]*ad-hoc signing[\s\S]*notarized by Apple/u, 'release notes must disclose the signing and notarization status');
assert.match(releaseWorkflow, /Gatekeeper[\s\S]*right-click \*\*谷子学术\.app\*\*[\s\S]*Open/u, 'release notes must include the first-launch Gatekeeper guidance');
assert.match(releaseWorkflow, /certifi==2025\.8\.3/u);
assert.doesNotMatch(releaseWorkflow, /^ {2}windows:/mu, 'Windows packaging must remain disabled until its runtime is self-contained');

const prepareMacSource = fs.readFileSync(path.join(root, 'scripts', 'prepare-mac-release.sh'), 'utf8');
assert.match(prepareMacSource, /import certifi; print\(certifi\.where\(\)\)/u);
assert.match(prepareMacSource, /my-scholar-server\/\$\{CA_BUNDLE_NAME\}/u);
assert.match(prepareMacSource, /test -s "\$\{RUNTIME_DIR\}\/my-scholar-server\/\$\{CA_BUNDLE_NAME\}"/u);
assert.match(prepareMacSource, /正式发布固定使用 arm64 Python 3\.11/u);
assert.match(prepareMacSource, /正式发布固定使用 JDK 21/u);
assert.match(prepareMacSource, /--exclude-module fitz/u);
assert.match(prepareMacSource, /--exclude-module pymupdf/u);
assert.match(prepareMacSource, /--release 11/u);
assert.match(prepareMacSource, /--dependency-smoke/u);
assert.match(prepareMacSource, /fetch-pandoc\.sh/u);
assert.match(prepareMacSource, /PANDOC_FETCHER[\s\S]*-f[\s\S]*PANDOC_FETCHER/u);
assert.match(prepareMacSource, /RUNTIME_DIR\}\/pandoc\/pandoc/u);

const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
assert.match(mainSource, /app\.setName\(PRODUCT_NAME\)/u);
assert.match(mainSource, /!app\.isPackaged[\s\S]*\$\{defaultUserDataPath\}-development/u);
assert.match(mainSource, /app\.isPackaged[\s\S]*python-server[\s\S]*my-scholar-server/u);
assert.match(mainSource, /packagedToolchainEnvironment[\s\S]*MY_SCHOLAR_ODL_JAR[\s\S]*MY_SCHOLAR_PANDOC[\s\S]*MY_SCHOLAR_JAVA[\s\S]*MY_SCHOLAR_PDF_RENDERER_CLASSPATH/u);
assert.match(mainSource, /python-server[\s\S]*ca-certificates\.crt[\s\S]*SSL_CERT_FILE: caBundle/u);
assert.match(mainSource, /stats\.isFile\(\) && stats\.size > 0/u);
assert.match(mainSource, /MY_SCHOLAR_PROJECT_ROOT: projectRoot/u);
assert.match(mainSource, /MY_SCHOLAR_COMPONENTS_DIR: path\.join\(app\.getPath\('userData'\), 'components'\)/u);
assert.match(mainSource, /MY_SCHOLAR_PACKAGED: app\.isPackaged \? '1' : '0'/u);
assert.match(mainSource, /UPDATE_CHANNEL = 'internal'/u);
assert.match(mainSource, /requestMacInstallation\(\{ app, dialog \}\)/u);
assert.match(mainSource, /consumeInstallationMarker\(\{ app \}\)/u);
assert.match(mainSource, /安装程序已自动退出/u);
assert.match(mainSource, /关闭并推出安装镜像/u);

const serverSource = fs.readFileSync(path.join(root, 'server.py'), 'utf8');
const pipelineSource = fs.readFileSync(path.join(root, 'pipeline.py'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'scripts', 'MyScholarPdfRenderer.java'), 'utf8');
assert.match(serverSource, /MY_SCHOLAR_PROJECT_ROOT/u);
assert.match(pipelineSource, /MY_SCHOLAR_JAVA/u);
assert.match(rendererSource, /"--evidence"/u);
assert.match(fs.readFileSync(path.join(root, 'layout_pipeline.py'), 'utf8'), /MY_SCHOLAR_PDF_RENDERER_CLASSPATH/u);
const updateManifest = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'release-manifests', 'macos-arm64.json'), 'utf8'));
if (/-internal\.dmg$/u.test(updateManifest.download_url)) assert.strictEqual(updateManifest.channel, 'internal');

const packagedApp = String(process.argv[2] || '').trim();
if (packagedApp) {
  const packagedAppRoot = path.resolve(packagedApp);
  const resourcesRoot = path.join(packagedAppRoot, 'Contents', 'Resources');
  assert.ok(fs.statSync(resourcesRoot).isDirectory(), 'the packaged app Resources directory must exist');
  assert.strictEqual(fs.existsSync(path.join(resourcesRoot, 'components')), false, 'managed components must stay in userData, outside the app bundle');
  for (const relative of ['app/component_manager.py', 'app/mineru_discovery.py', 'app/parsing_providers.py']) {
    assert.ok(fs.statSync(path.join(resourcesRoot, relative)).isFile(), `${relative} is missing from the packaged app`);
  }
  const forbidden = walkFiles(resourcesRoot).filter((relative) =>
    /(^|\/)(?:mineru(?:\/|$)|models?(?:\/|$))|\.(?:safetensors|onnx|ckpt|pth)$/iu.test(relative),
  );
  assert.deepStrictEqual(forbidden, [], `the default app bundle contains managed runtime/model files: ${forbidden.join(', ')}`);
  const packagedBytes = walkFiles(packagedAppRoot).reduce((total, relative) => total + fs.lstatSync(path.join(packagedAppRoot, relative)).size, 0);
  assert.ok(packagedBytes <= 768 * 1024 * 1024, `the default app bundle exceeded the 768 MiB size budget (${packagedBytes} bytes)`);

  const java = path.join(resourcesRoot, 'java', 'bin', 'java');
  const server = path.join(resourcesRoot, 'python-server', 'my-scholar-server');
  const caBundle = path.join(resourcesRoot, 'python-server', 'ca-certificates.crt');
  const odlJar = path.join(resourcesRoot, 'toolchain', 'opendataloader-pdf-cli-0.0.0.jar');
  const pandoc = path.join(resourcesRoot, 'toolchain', 'pandoc', 'pandoc');
  const renderer = path.join(resourcesRoot, 'toolchain', 'pdf-renderer');
  const actualOdlSha = crypto.createHash('sha256').update(fs.readFileSync(odlJar)).digest('hex');
  assert.strictEqual(actualOdlSha, '104a5523c812ba3a43a3c7dd6156e33f23d0e32f03ef1ac629009ef96d7a79e1');
  assert.ok(fs.statSync(pandoc).isFile(), 'bundled Pandoc must be present');
  assert.ok(fs.statSync(path.join(resourcesRoot, 'licenses', 'pandoc', 'COPYING.md')).isFile(), 'Pandoc license must be present');
  for (const executable of [path.join(packagedAppRoot, 'Contents', 'MacOS', '谷子学术'), server, java, pandoc]) {
    assert.match(runChecked('/usr/bin/file', [executable]).stdout, /arm64/u, `${executable} is not arm64`);
  }
  const pandocRun = runChecked(pandoc, ['--from=markdown+tex_math_dollars+tex_math_single_backslash', '--to=html5', '--mathml'], {
    input: '$$\n\\pmb { H } _ { l } ^ { \\prime } = \\mathrm { M S A } \\tag{1}\n$$\n',
  });
  assert.match(pandocRun.stdout, /<math\b/u, 'bundled Pandoc must produce MathML');
  const modules = runChecked(java, ['--list-modules']).stdout;
  for (const module of ['java.base', 'java.compiler', 'java.desktop', 'java.management', 'java.sql']) {
    assert.match(modules, new RegExp(`^${module}@`, 'mu'), `bundled Java is missing ${module}`);
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-packaged-runtime-'));
  try {
    const stateDir = path.join(temporary, 'state');
    const libraryDir = path.join(temporary, 'library');
    const componentsDir = path.join(temporary, 'components');
    fs.mkdirSync(stateDir);
    fs.mkdirSync(libraryDir);
    fs.mkdirSync(componentsDir);
    const dependency = runChecked(server, ['--dependency-smoke'], {
      env: {
        ...process.env,
        SSL_CERT_FILE: caBundle,
        MY_SCHOLAR_DATA_DIR: stateDir,
        MY_SCHOLAR_LIBRARY_DIR: libraryDir,
        MY_SCHOLAR_COMPONENTS_DIR: componentsDir,
        MY_SCHOLAR_PACKAGED: '1',
      },
    });
    const dependencyStatus = JSON.parse(dependency.stdout.trim().split(/\r?\n/u).at(-1));
    assert.strictEqual(dependencyStatus.ok, true);
    assert.strictEqual(dependencyStatus.hashlib_scrypt, true);
    assert.deepStrictEqual(dependencyStatus.providers.map((provider) => provider.id), ['local-mineru', 'remote-guzi']);

    const sourcePdf = path.join(temporary, 'runtime-smoke.pdf');
    const odlOutput = path.join(temporary, 'odl');
    const pageOutput = path.join(temporary, 'pages');
    fs.writeFileSync(sourcePdf, minimalPdf());
    fs.mkdirSync(pageOutput);
    const javaBaseArgs = ['--add-opens=java.base/java.nio=ALL-UNNAMED', '-Djava.awt.headless=true'];
    const odlRun = runChecked(java, [
      ...javaBaseArgs,
      '-jar', odlJar,
      '-q', '-f', 'json,html', '--image-output', 'external',
      '-o', odlOutput,
      sourcePdf,
    ]);
    assert.doesNotMatch(`${odlRun.stdout || ''}\n${odlRun.stderr || ''}`, /InaccessibleObjectException/u);
    assert.ok(fs.statSync(path.join(odlOutput, 'runtime-smoke.json')).isFile());
    assert.ok(fs.statSync(path.join(odlOutput, 'runtime-smoke.html')).isFile());
    const rendererRun = runChecked(java, [
      ...javaBaseArgs,
      '-cp', `${renderer}${path.delimiter}${odlJar}`,
      'MyScholarPdfRenderer', sourcePdf, pageOutput, '72', '1',
    ]);
    assert.doesNotMatch(`${rendererRun.stdout || ''}\n${rendererRun.stderr || ''}`, /InaccessibleObjectException/u);
    assert.deepStrictEqual(readPngSize(path.join(pageOutput, 'page-001.png')), { width: 200, height: 200 });
    const evidenceOutput = path.join(temporary, 'evidence.json');
    const evidenceRun = runChecked(java, [
      ...javaBaseArgs,
      '-cp', `${renderer}${path.delimiter}${odlJar}`,
      'MyScholarPdfRenderer', '--evidence', sourcePdf, evidenceOutput,
    ]);
    assert.doesNotMatch(`${evidenceRun.stdout || ''}\n${evidenceRun.stderr || ''}`, /InaccessibleObjectException/u);
    const evidence = JSON.parse(fs.readFileSync(evidenceOutput, 'utf8'));
    const evidenceSpans = evidence.flatMap((page) => page.spans || []);
    assert.ok(evidenceSpans.some((span) => span.color === 0xFF0000), 'PDFBox evidence must preserve red text');
    assert.ok(evidenceSpans.some((span) => span.color === 0x0000FF), 'PDFBox evidence must preserve blue text');
    assert.ok(
      evidenceSpans.some((span) => span.color !== 0 && Array.isArray(span.chars) && span.chars.length > 0),
      'PDFBox evidence must include character-level geometry for styled text',
    );
    assert.ok(
      evidenceSpans.some((span) => span.bold === true && /bold/u.test(span.text || '')),
      'PDFBox evidence must preserve bold text',
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

console.log('mac release integration tests passed');
